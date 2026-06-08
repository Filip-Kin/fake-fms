import { useState } from "react";
import { FAULT_TYPES, type FaultType, type FmsState, type StationKey } from "shared";
import { control } from "../api";
import { Button, Card, NumberInput } from "../components/ui";

const ROBOTS: StationKey[] = ["red1", "red2", "red3", "blue1", "blue2", "blue3"];

export function Faults({ state }: { state: FmsState }) {
	const matches = state.schedule;
	const [matchId, setMatchId] = useState(matches[0]?.fmsMatchId ?? "");
	const [robot, setRobot] = useState<StationKey>("red1");
	const [fault, setFault] = useState<FaultType>("rioDisconnect");
	const [startSec, setStartSec] = useState(60);
	const [durationSec, setDurationSec] = useState(6);

	const entry = matches.find((m) => m.fmsMatchId === matchId);
	const teamFor = (r: StationKey): number | undefined => {
		if (!entry) return undefined;
		const idx = Number(r.slice(-1)) - 1;
		return r.startsWith("red") ? entry.red[idx] : entry.blue[idx];
	};

	const apply = () =>
		control("/control/faults/set", { matchId, robot, faults: [{ type: fault, startSec, durationSec }] });

	const configured = Object.entries(state.logFaults);

	return (
		<div className="space-y-4">
			<Card title="Inject a match-log fault">
				<p className="mb-3 text-sm text-slate-400">
					Faults are baked into the generated logs the extension downloads for that match + robot, and are
					detected by FTA-Buddy's analyzer (RIO disconnect, brownout, high ping, etc.).
				</p>
				<div className="grid gap-3 sm:grid-cols-2">
					<Labeled label="Match">
						<select
							value={matchId}
							onChange={(e) => setMatchId(e.target.value)}
							className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
						>
							{matches.map((m) => (
								<option key={m.fmsMatchId} value={m.fmsMatchId}>
									{m.description}
								</option>
							))}
						</select>
					</Labeled>
					<Labeled label="Robot">
						<select
							value={robot}
							onChange={(e) => setRobot(e.target.value as StationKey)}
							className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
						>
							{ROBOTS.map((r) => (
								<option key={r} value={r}>
									{r} ({teamFor(r) ?? "?"})
								</option>
							))}
						</select>
					</Labeled>
					<Labeled label="Fault">
						<select
							value={fault}
							onChange={(e) => setFault(e.target.value as FaultType)}
							className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
						>
							{FAULT_TYPES.map((f) => (
								<option key={f} value={f}>
									{f}
								</option>
							))}
						</select>
					</Labeled>
					<div className="flex items-end gap-2">
						<Labeled label="Start (s)">
							<NumberInput value={startSec} onChange={setStartSec} />
						</Labeled>
						<Labeled label="Duration (s)">
							<NumberInput value={durationSec} onChange={setDurationSec} />
						</Labeled>
					</div>
				</div>
				<div className="mt-3 flex gap-2">
					<Button variant="primary" onClick={apply}>
						Set fault
					</Button>
					<Button variant="ghost" onClick={() => control("/control/faults/clear")}>
						Clear all
					</Button>
				</div>
			</Card>

			<Card title={`Configured faults (${configured.length})`}>
				{configured.length === 0 ? (
					<p className="text-sm text-slate-500">None. Logs generate clean.</p>
				) : (
					<table className="w-full text-left text-sm">
						<thead className="text-xs uppercase text-slate-500">
							<tr>
								<th className="py-1">Match / robot</th>
								<th className="py-1">Faults</th>
								<th className="py-1"></th>
							</tr>
						</thead>
						<tbody>
							{configured.map(([key, faults]) => {
								const [mId, r] = key.split(":");
								const desc = matches.find((m) => m.fmsMatchId === mId)?.description ?? mId;
								return (
									<tr key={key} className="border-t border-slate-800">
										<td className="py-1">
											{desc} <span className="text-slate-500">{r}</span>
										</td>
										<td className="py-1 text-slate-300">
											{faults.map((f) => `${f.type}@${f.startSec ?? "mid"}s/${f.durationSec ?? "def"}s`).join(", ")}
										</td>
										<td className="py-1 text-right">
											<Button
												variant="danger"
												className="!px-2 !py-0.5 !text-xs"
												onClick={() => control("/control/faults/set", { matchId: mId, robot: r, faults: [] })}
											>
												Remove
											</Button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</Card>
		</div>
	);
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<label className="block">
			<span className="mb-1 block text-xs uppercase text-slate-400">{label}</span>
			{children}
		</label>
	);
}
