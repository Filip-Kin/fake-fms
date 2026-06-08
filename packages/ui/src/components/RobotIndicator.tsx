import type { StationCycle, StationKey, StationState } from "shared";
import { control } from "../api";
import { Button } from "./ui";

const CYCLE_COLOR: Record<StationCycle, string> = {
	none: "bg-red-700",
	ds: "bg-amber-600",
	radio: "bg-amber-500",
	rio: "bg-sky-600",
	code: "bg-emerald-700",
	green: "bg-emerald-500",
	wrongStation: "bg-fuchsia-600",
	waiting: "bg-slate-500",
};

const CYCLE_LABEL: Record<StationCycle, string> = {
	none: "No DS",
	ds: "DS",
	radio: "Radio",
	rio: "RIO",
	code: "Code",
	green: "Green",
	wrongStation: "Wrong Station",
	waiting: "Waiting",
};

function pip(on: boolean, label: string) {
	return (
		<span className={`rounded px-1 text-[10px] ${on ? "bg-emerald-500 text-black" : "bg-slate-700 text-slate-400"}`}>
			{label}
		</span>
	);
}

export function RobotIndicator({ k, s }: { k: StationKey; s: StationState }) {
	const overlay = s.estop ? "ESTOP" : s.astop ? "ASTOP" : s.bypassed ? "BYPASS" : null;
	const bg = s.estop ? "bg-red-900" : s.bypassed ? "bg-fuchsia-800" : CYCLE_COLOR[s.cycle];
	const dsOn = s.cycle !== "none";
	const radioOn = ["radio", "rio", "code", "green"].includes(s.cycle);
	const rioOn = ["rio", "code", "green"].includes(s.cycle);
	const codeOn = ["code", "green"].includes(s.cycle);

	return (
		<div className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
			<button
				onClick={() => control(`/control/station/${k}/cycle`)}
				className={`flex h-20 flex-col items-center justify-center rounded ${bg} text-white transition hover:brightness-110`}
				title="Click to cycle connection status"
			>
				<span className="text-lg font-bold">{s.teamNumber}</span>
				<span className="text-xs">{overlay ?? CYCLE_LABEL[s.cycle]}</span>
			</button>
			<div className="flex justify-between gap-1">
				{pip(dsOn, "DS")}
				{pip(radioOn, "RAD")}
				{pip(rioOn, "RIO")}
				{pip(codeOn, "CODE")}
			</div>
			<div className="flex flex-wrap gap-1">
				<Button
					variant={s.bypassed ? "danger" : "ghost"}
					className="!px-2 !py-0.5 !text-xs"
					onClick={() => control(`/control/station/${k}/bypass`, { on: !s.bypassed })}
				>
					Bypass
				</Button>
				<Button
					variant={s.estop ? "danger" : "ghost"}
					className="!px-2 !py-0.5 !text-xs"
					onClick={() => control(`/control/station/${k}/estop`, { on: !s.estop })}
				>
					E-Stop
				</Button>
				<Button
					variant={s.astop ? "danger" : "ghost"}
					className="!px-2 !py-0.5 !text-xs"
					onClick={() => control(`/control/station/${k}/astop`, { on: !s.astop })}
				>
					A-Stop
				</Button>
			</div>
		</div>
	);
}
