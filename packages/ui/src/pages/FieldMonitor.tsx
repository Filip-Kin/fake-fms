import type { FmsState, StationKey } from "shared";
import { control } from "../api";
import { RobotIndicator } from "../components/RobotIndicator";
import { Button } from "../components/ui";

const RED: StationKey[] = ["red1", "red2", "red3"];
const BLUE: StationKey[] = ["blue1", "blue2", "blue3"];

export function FieldMonitor({ state }: { state: FmsState }) {
	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-slate-400">
					Click each indicator to cycle it. DS: red &rarr; X &rarr; green &rarr; W &rarr; M. Radio/RIO/Code: red
					&rarr; X &rarr; green.
				</p>
				<Button variant="ghost" onClick={() => control("/control/stations/reset")}>
					Reset all
				</Button>
			</div>

			<div>
				<h3 className="mb-2 text-sm font-semibold text-red-400">Red Alliance</h3>
				<div className="grid grid-cols-3 gap-3">
					{RED.map((k) => (
						<RobotIndicator key={k} k={k} s={state.stations[k]} />
					))}
				</div>
			</div>

			<div>
				<h3 className="mb-2 text-sm font-semibold text-sky-400">Blue Alliance</h3>
				<div className="grid grid-cols-3 gap-3">
					{BLUE.map((k) => (
						<RobotIndicator key={k} k={k} s={state.stations[k]} />
					))}
				</div>
			</div>
		</div>
	);
}
