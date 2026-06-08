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
	const rng = makeRng(opts.seed);
	const jitter = (mag: number) => (rng() - 0.5) * 2 * mag;

	const phases: Phase[] = [
		{ durationSec: auto, enabled: true, auto: true },
		{ durationSec: transition, enabled: false, auto: false },
		{ durationSec: teleop, enabled: true, auto: false },
	];

	// Normalise fault windows to absolute [start, end] seconds from match start.
	const faults = (opts.faults ?? []).map((f) => {
		const dur = f.durationSec ?? DEFAULT_FAULT_DURATION[f.type];
		const start = f.startSec ?? auto + transition + teleop / 2; // default: mid-teleop
		return { type: f.type, start, end: start + dur };
	});
	const faultActive = (t: number, type: FaultType) => faults.some((f) => f.type === type && t >= f.start && t < f.end);

	const frames: FMSLogFrame[] = [];
	let elapsed = 0;
	let sentPackets = 0;
	const step = 1 / hz;
	const startMs = opts.startTimeMs ?? Date.UTC(2026, 2, 27, 14, 0, 0);

	// Autocorrelated state so the graphs read like real telemetry (smooth curves that drift and
	// mean-revert) rather than per-frame white noise. AR(1): value += (target - value)*k + noise.
	let battery = 12.9;
	let trip = 3.5;
	let signal = -47;
	let dataRate = 0.5;
	// Tx/Rx data rate (Mbps) chosen from the real 802.11 MCS rate table, drifting with link quality.
	const RATE_TABLE = [137.6, 206.5, 275.3, 412.9, 550.6, 619.4, 688.2, 825.9];
	let rateIdx = 4;
	const ar = (v: number, target: number, k: number, noise: number) => v + (target - v) * k + jitter(noise);

	for (const phase of phases) {
		const frameCount = Math.round(phase.durationSec * hz);
		for (let i = 0; i < frameCount; i++) {
			const matchTime = +(phase.durationSec - i * step).toFixed(2); // counts down within the period

			// Link hierarchy, broken by the most severe active disconnect.
			let dsLink = true;
			let radioLink = true;
			let rioLink = true;
			let codeLink = true;
			if (faultActive(elapsed, "dsDisconnect")) dsLink = radioLink = rioLink = codeLink = false;
			else if (faultActive(elapsed, "radioDisconnect")) radioLink = rioLink = codeLink = false;
			else if (faultActive(elapsed, "rioDisconnect")) rioLink = codeLink = false;
			else if (faultActive(elapsed, "codeDisconnect")) codeLink = false;

			const connected = dsLink && radioLink && rioLink && codeLink;
			const enabled = phase.enabled && dsLink && rioLink && codeLink;

			// Battery: smooth sag toward a load-dependent baseline; brownout pulls it down hard.
			const brownoutFault = faultActive(elapsed, "brownout");
			const batteryTarget = brownoutFault ? 6.4 : 12.8 - (enabled ? 0.9 : 0.1) - (phase.auto ? 0.3 : 0);
			battery = Math.min(13.2, Math.max(5.5, ar(battery, batteryTarget, brownoutFault ? 0.5 : 0.12, 0.05)));
			const brownout = battery < 7;

			// Ping: low and smooth, with fault-driven elevation/spikes.
			let tripTarget = 3.5;
			if (faultActive(elapsed, "highPing")) tripTarget = 140;
			else if (faultActive(elapsed, "sustainedPing")) tripTarget = 18;
			trip = Math.max(0.5, ar(trip, tripTarget, 0.35, 0.6));
			if (!connected) trip = 0;

			// Signal: slow drift (robot moving around the field), low-signal fault pushes it down.
			const signalTarget = faultActive(elapsed, "lowSignal") ? -78 : -47 + Math.sin(elapsed / 25) * 4;
			signal = ar(signal, signalTarget, 0.1, 0.7);
			const noise = -90 + jitter(1.5);
			const snr = signal - noise;

			// Bandwidth: smooth, higher under load; high-BWU fault pushes over threshold.
			const dataTarget = faultActive(elapsed, "highBandwidth") ? 7.6 : enabled ? 2.4 : 0.5;
			dataRate = Math.max(0.1, ar(dataRate, dataTarget, 0.2, 0.25));

			// Tx/Rx rate drifts with signal quality across the MCS rate table.
			const idxTarget = signal > -50 ? 5 : signal > -65 ? 4 : 2;
			if (rng() < 0.15) rateIdx += Math.sign(idxTarget - rateIdx);
			rateIdx = Math.max(0, Math.min(RATE_TABLE.length - 1, rateIdx));
			const rate = RATE_TABLE[rateIdx]!;

			const lostPackets = connected ? (trip > 100 || dataRate > 7 ? Math.round(Math.abs(jitter(5))) : 0) : 0;
			sentPackets += connected ? 25 + Math.round(jitter(3)) : 0;

			frames.push({
				timeStamp: new Date(startMs + elapsed * 1000).toISOString(),
				matchTimeBase: phase.durationSec,
				matchTime,
				auto: phase.auto,
				dsLinkActive: dsLink,
				enabled,
				aStopPressed: false,
				eStopPressed: false,
				linkActive: codeLink,
				radioLink,
				rioLink,
				averageTripTime: +trip.toFixed(1),
				lostPackets,
				sentPackets,
				battery: +battery.toFixed(2),
				brownout,
				signal: connected ? +signal.toFixed(1) : null,
				noise: connected ? +noise.toFixed(1) : null,
				snr: connected ? +snr.toFixed(1) : null,
				txRate: connected ? rate : null,
				txMCS: connected ? rateIdx + 1 : null,
				rxRate: connected ? rate : null,
				rxMCS: connected ? rateIdx + 1 : null,
				dataRateTotal: +dataRate.toFixed(2),
			});
			elapsed += step;
		}
	}
	return frames;
}
