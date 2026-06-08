import type { FmsState } from "shared";
import { control } from "../api";
import { Button, Card } from "../components/ui";

const STEPS = [
	{ label: "Prestart", path: "/control/match/prestart", variant: "neutral" as const },
	{ label: "Show Match Preview", path: "/control/match/show-preview", variant: "neutral" as const },
	{ label: "Set Audience", path: "/control/match/preview", variant: "neutral" as const },
	{ label: "Match Ready", path: "/control/match/arm", variant: "neutral" as const },
	{ label: "Start Match", path: "/control/match/start", variant: "primary" as const },
	{ label: "Commit Scores", path: "/control/match/commit", variant: "primary" as const },
	{ label: "Post Results", path: "/control/match/post", variant: "primary" as const },
];

// Audience-display screens the operator can switch to manually (the FMS video switch).
const SCREENS: { label: string; option: string }[] = [
	{ label: "Video Only", option: "VideoOnly" },
	{ label: "Video + Score", option: "VideoAndScore" },
	{ label: "Match Preview", option: "MatchPreview" },
	{ label: "Match Result", option: "MatchResults" },
	{ label: "Bracket", option: "Bracket" },
	{ label: "Rankings", option: "Rankings" },
	{ label: "Schedule", option: "Schedule" },
	{ label: "Alliance Sel", option: "AllianceHybrid" },
	{ label: "Alliance Full", option: "AllianceFullscreen" },
	{ label: "Timeout", option: "Timeout" },
	{ label: "Timer Bug", option: "TimerBug" },
	{ label: "Background", option: "Background" },
];

export function MatchControl({ state }: { state: FmsState }) {
	const { current, timer } = state;
	return (
		<div className="grid gap-4 md:grid-cols-2">
			<Card title="Current Match">
				<div className="space-y-2 text-sm">
					<Row label="Level" value={current.level} />
					<Row label="Match" value={`${current.matchNumber} (play ${current.playNumber})`} />
					<Row label="State" value={current.matchState} />
					<Row label="Phase" value={timer.phase} />
				</div>
				<div className="mt-4 flex items-end gap-4">
					<div className="text-6xl font-bold tabular-nums text-white">{timer.secondsRemaining}</div>
					<span className={`mb-2 text-xs ${timer.running ? "text-emerald-400" : "text-slate-500"}`}>
						{timer.running ? "running" : "stopped"}
					</span>
				</div>
			</Card>

			<Card title="Controls">
				<div className="flex flex-wrap gap-2">
					{STEPS.map((s) => (
						<Button key={s.label} variant={s.variant} onClick={() => control(s.path)}>
							{s.label}
						</Button>
					))}
					<Button variant="danger" onClick={() => control("/control/match/abort")}>
						Abort
					</Button>
				</div>
				<p className="mt-3 text-xs text-slate-500">
					Once started, the match runs auto (20s) &rarr; teleop (140s) automatically. Commit locks the
					scores; Post Results shows them to the audience (and triggers FTA-Buddy log pulls).
				</p>
			</Card>

			<Card title="Audience Display">
				<p className="mb-2 text-xs text-slate-500">
					Current: <span className="text-slate-300">{state.event.videoSwitchOption}</span>. The match
					lifecycle drives this automatically; use these to switch screens manually.
				</p>
				<div className="flex flex-wrap gap-2">
					{SCREENS.map((s) => (
						<Button
							key={s.option}
							variant={state.event.videoSwitchOption === s.option ? "primary" : "ghost"}
							onClick={() => control("/control/video", { option: s.option })}
						>
							{s.label}
						</Button>
					))}
				</div>
			</Card>

			<Card title="Select Match">
				<MatchSelect state={state} />
			</Card>
		</div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex justify-between border-b border-slate-800 pb-1">
			<span className="text-slate-400">{label}</span>
			<span className="font-medium text-slate-100">{value}</span>
		</div>
	);
}

function MatchSelect({ state }: { state: FmsState }) {
	const matches = state.schedule.filter((m) => m.level === state.current.level);
	return (
		<div className="max-h-64 space-y-1 overflow-y-auto">
			{matches.map((m) => {
				const active = m.matchNumber === state.current.matchNumber;
				return (
					<button
						key={m.fmsMatchId}
						onClick={() =>
							control("/control/match/select", {
								matchNumber: m.matchNumber,
								playNumber: m.playNumber,
								level: m.level,
							})
						}
						className={`flex w-full justify-between rounded px-2 py-1 text-left text-xs ${
							active ? "bg-emerald-700 text-white" : "bg-slate-800 hover:bg-slate-700"
						}`}
					>
						<span>{m.description}</span>
						<span className="text-slate-400">
							<span className="text-red-400">{m.red.join(" ")}</span> vs{" "}
							<span className="text-sky-400">{m.blue.join(" ")}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}
