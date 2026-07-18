import type { FaultType, FMSLogFrame, LogFaultSpec } from "shared";

// #region fault model

export interface GenerateLogOptions {
	seed: number;
	faults?: LogFaultSpec[];
	autoSeconds?: number;
	teleopSeconds?: number;
	/** Disabled gap between auto and teleop. Real 2026 has none, so live replay passes 0. */
	transitionSeconds?: number;
	hz?: number;
	/** Wall-clock match start (ms epoch) used for frame timeStamps. */
	startTimeMs?: number;
}

// #endregion

// #region deterministic RNG

/** mulberry32 - small, fast, deterministic PRNG so a given match+station always yields the same log. */
function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function hashSeed(str: string): number {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

// #endregion

interface Phase {
	durationSec: number;
	enabled: boolean;
	auto: boolean;
}

// #region stepwise generator state (shared by the batch log and the live pre-match idle stream)

/**
 * Autocorrelated per-robot telemetry state. Carried across frames so the graphs read like real
 * telemetry (smooth curves that drift and mean-revert) rather than per-frame white noise.
 */
export interface LogState {
	rng: () => number;
	battery: number;
	trip: number;
	signal: number;
	dataRate: number;
	rateIdx: number;
	sentPackets: number;
	/** Transient voltage sag from an acceleration load spike; builds when driving, decays each frame. */
	loadDip: number;
}

export function createLogState(seed: number): LogState {
	return { rng: makeRng(seed), battery: 12.9, trip: 3.5, signal: -47, dataRate: 0.5, rateIdx: 4, sentPackets: 0, loadDip: 0 };
}

const RATE_TABLE = [137.6, 206.5, 275.3, 412.9, 550.6, 619.4, 688.2, 825.9];

interface NormFault {
	type: FaultType;
	start: number;
	end: number;
}

export interface StepInput {
	/** Seconds from match start, used for fault windows + signal drift (idle stream passes a counter). */
	elapsed: number;
	enabled: boolean;
	auto: boolean;
	matchTimeBase: number;
	matchTime: number;
	faults: NormFault[];
	startMs: number;
}

/**
 * Produce one telemetry frame, advancing `st`. Battery is the headline behaviour: when the robot is
 * DISABLED (pre-match, transition, post-match) the pack voltage sits high and smooth; when ENABLED
 * (driving) the drivetrain pulls big, bursty current so the voltage jumps up and down a lot as it
 * sags under acceleration and recovers when coasting. A brownout fault pulls it down hard.
 */
export function stepLogFrame(st: LogState, inp: StepInput): FMSLogFrame {
	const rng = st.rng;
	const jitter = (mag: number) => (rng() - 0.5) * 2 * mag;
	const ar = (v: number, target: number, k: number, noise: number) => v + (target - v) * k + jitter(noise);
	const faultActive = (type: FaultType) => inp.faults.some((f) => f.type === type && inp.elapsed >= f.start && inp.elapsed < f.end);

	// Link hierarchy, broken by the most severe active disconnect.
	let dsLink = true;
	let radioLink = true;
	let rioLink = true;
	let codeLink = true;
	if (faultActive("dsDisconnect")) dsLink = radioLink = rioLink = codeLink = false;
	else if (faultActive("radioDisconnect")) radioLink = rioLink = codeLink = false;
	else if (faultActive("rioDisconnect")) rioLink = codeLink = false;
	else if (faultActive("codeDisconnect")) codeLink = false;

	const connected = dsLink && radioLink && rioLink && codeLink;
	const enabled = inp.enabled && dsLink && rioLink && codeLink;

	// Battery: rest voltage mean-reverts smoothly; while enabled, acceleration load spikes add a
	// transient dip that decays, and the per-frame noise is much larger (the "jumping around").
	const brownoutFault = faultActive("brownout");
	if (enabled) {
		if (rng() < 0.5) st.loadDip += rng() * (inp.auto ? 1.5 : 1.2); // a new burst of drivetrain draw
		st.loadDip = Math.min(st.loadDip * 0.55, 4.5); // recover toward rest
	} else {
		st.loadDip *= 0.4; // settle quickly when not driving
	}
	const restTarget = brownoutFault ? 6.4 : enabled ? 12.5 : 12.85;
	const restNoise = enabled ? 0.22 : 0.02; // jumpy under load, smooth at idle
	const k = brownoutFault ? 0.5 : enabled ? 0.4 : 0.08;
	st.battery = ar(st.battery, restTarget, k, restNoise);
	const battery = Math.min(13.2, Math.max(5.5, st.battery - st.loadDip));
	const brownout = battery < 7;

	// Ping: low and smooth, with fault-driven elevation/spikes.
	let tripTarget = 3.5;
	if (faultActive("highPing")) tripTarget = 140;
	else if (faultActive("sustainedPing")) tripTarget = 18;
	st.trip = Math.max(0.5, ar(st.trip, tripTarget, 0.35, 0.6));
	if (!connected) st.trip = 0;

	// Signal: slow drift (robot moving around the field), low-signal fault pushes it down.
	const signalTarget = faultActive("lowSignal") ? -78 : -47 + Math.sin(inp.elapsed / 25) * 4;
	st.signal = ar(st.signal, signalTarget, 0.1, 0.7);
	const noise = -90 + jitter(1.5);
	const snr = st.signal - noise;

	// Bandwidth: smooth, higher under load; high-BWU fault pushes over threshold.
	const dataTarget = faultActive("highBandwidth") ? 7.6 : enabled ? 2.4 : 0.5;
	st.dataRate = Math.max(0.1, ar(st.dataRate, dataTarget, 0.2, 0.25));

	// Tx/Rx rate drifts with signal quality across the MCS rate table.
	const idxTarget = st.signal > -50 ? 5 : st.signal > -65 ? 4 : 2;
	if (rng() < 0.15) st.rateIdx += Math.sign(idxTarget - st.rateIdx);
	st.rateIdx = Math.max(0, Math.min(RATE_TABLE.length - 1, st.rateIdx));
	const rate = RATE_TABLE[st.rateIdx]!;

	const lostPackets = connected ? (st.trip > 100 || st.dataRate > 7 ? Math.round(Math.abs(jitter(5))) : 0) : 0;
	st.sentPackets += connected ? 25 + Math.round(jitter(3)) : 0;

	return {
		timeStamp: new Date(inp.startMs + inp.elapsed * 1000).toISOString(),
		matchTimeBase: inp.matchTimeBase,
		matchTime: inp.matchTime,
		auto: inp.auto,
		dsLinkActive: dsLink,
		enabled,
		aStopPressed: false,
		eStopPressed: false,
		linkActive: codeLink,
		radioLink,
		rioLink,
		averageTripTime: +st.trip.toFixed(1),
		lostPackets,
		sentPackets: st.sentPackets,
		battery: +battery.toFixed(2),
		brownout,
		signal: connected ? +st.signal.toFixed(1) : null,
		noise: connected ? +noise.toFixed(1) : null,
		snr: connected ? +snr.toFixed(1) : null,
		txRate: connected ? rate : null,
		txMCS: connected ? st.rateIdx + 1 : null,
		rxRate: connected ? rate : null,
		rxMCS: connected ? st.rateIdx + 1 : null,
		dataRateTotal: +st.dataRate.toFixed(2),
	};
}

// #endregion

const DEFAULT_FAULT_DURATION: Record<FaultType, number> = {
	dsDisconnect: 4,
	radioDisconnect: 5,
	rioDisconnect: 6,
	codeDisconnect: 5,
	brownout: 8, // FTA-Buddy only reports brownouts lasting > 5s
	highPing: 6,
	sustainedPing: 40,
	lowSignal: 40,
	highBandwidth: 40,
};

/**
 * Generate a realistic per-robot match log: auto -> transition -> teleop frames at the given
 * cadence, with believable battery sag / ping jitter / signal, and any injected faults applied
 * over their window using the same link hierarchy FTA-Buddy's analyzer expects
 * (ds >= radio >= rio >= code).
 */
export function generateStationLog(opts: GenerateLogOptions): FMSLogFrame[] {
	const auto = opts.autoSeconds ?? 15;
	const teleop = opts.teleopSeconds ?? 135;
	const transition = opts.transitionSeconds ?? 3;
	const hz = opts.hz ?? 2;
	const step = 1 / hz;
	const startMs = opts.startTimeMs ?? Date.UTC(2026, 2, 27, 14, 0, 0);

	const phases: Phase[] = [
		{ durationSec: auto, enabled: true, auto: true },
		{ durationSec: transition, enabled: false, auto: false },
		{ durationSec: teleop, enabled: true, auto: false },
	];

	// Normalise fault windows to absolute [start, end] seconds from match start.
	const faults: NormFault[] = (opts.faults ?? []).map((f) => {
		const dur = f.durationSec ?? DEFAULT_FAULT_DURATION[f.type];
		const start = f.startSec ?? auto + transition + teleop / 2; // default: mid-teleop
		return { type: f.type, start, end: start + dur };
	});

	const st = createLogState(opts.seed);
	const frames: FMSLogFrame[] = [];
	let elapsed = 0;
	for (const phase of phases) {
		const frameCount = Math.round(phase.durationSec * hz);
		for (let i = 0; i < frameCount; i++) {
			frames.push(
				stepLogFrame(st, {
					elapsed,
					enabled: phase.enabled,
					auto: phase.auto,
					matchTimeBase: phase.durationSec,
					matchTime: +(phase.durationSec - i * step).toFixed(2), // counts down within the period
					faults,
					startMs,
				}),
			);
			elapsed += step;
		}
	}
	return frames;
}
