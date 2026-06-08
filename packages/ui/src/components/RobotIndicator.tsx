import type { StationKey, StationPart, StationState } from "shared";
import { control } from "../api";
import { Button } from "./ui";

// Map a part state to a colour + letter overlay matching FTA-Buddy's field monitor.
const STATE_STYLE: Record<string, { color: string; letter: string }> = {
	red: { color: "bg-red-600", letter: "" },
	greenX: { color: "bg-green-600", letter: "X" },
	green: { color: "bg-green-500", letter: "" },
	waiting: { color: "bg-amber-500", letter: "W" },
	move: { color: "bg-sky-600", letter: "M" },
};

function Indicator({ k, part, label, state }: { k: StationKey; part: StationPart; label: string; state: string }) {
	const style = STATE_STYLE[state] ?? STATE_STYLE.red!;
	return (
		<button
			onClick={() => control(`/control/station/${k}/cycle/${part}`)}
			className={`flex h-10 flex-1 flex-col items-center justify-center rounded ${style.color} text-white transition hover:brightness-110`}
			title={`${label}: ${state} (click to cycle)`}
		>
			<span className="text-[10px] leading-none opacity-80">{label}</span>
			<span className="text-xs font-bold leading-tight">{style.letter || " "}</span>
		</button>
	);
}

export function RobotIndicator({ k, s }: { k: StationKey; s: StationState }) {
	const overlay = s.estop ? "ESTOP" : s.astop ? "ASTOP" : s.bypassed ? "BYPASS" : null;
	const headerBg = s.estop ? "bg-red-900" : s.astop ? "bg-orange-700" : s.bypassed ? "bg-fuchsia-800" : "bg-slate-800";

	return (
		<div className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
			<div className={`flex items-center justify-between rounded px-2 py-1 ${headerBg}`}>
				<span className="text-lg font-bold text-white">{s.teamNumber}</span>
				{overlay && <span className="text-xs font-semibold text-white">{overlay}</span>}
			</div>

			<div className="flex gap-1">
				<Indicator k={k} part="ds" label="DS" state={s.ds} />
				<Indicator k={k} part="radio" label="RAD" state={s.radio} />
				<Indicator k={k} part="rio" label="RIO" state={s.rio} />
				<Indicator k={k} part="code" label="CODE" state={s.code} />
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
