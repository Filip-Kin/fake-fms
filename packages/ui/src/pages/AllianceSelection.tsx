import type { FmsState } from "shared";
import { control } from "../api";
import { Button, Card } from "../components/ui";

// #region helpers

interface Slot {
	alliance: number;
	round: 1 | 2;
}

/** The serpentine pick order (alliances 1..N first pick, then N..1 second pick). */
function pickOrder(n: number): Slot[] {
	const order: Slot[] = [];
	for (let a = 1; a <= n; a++) order.push({ alliance: a, round: 1 });
	for (let a = n; a >= 1; a--) order.push({ alliance: a, round: 2 });
	return order;
}

function currentSlot(state: FmsState): Slot | null {
	const sel = state.allianceSelection;
	if (!sel?.active) return null;
	return pickOrder(state.alliances.length || 8)[sel.pickIndex] ?? null;
}

function teamName(state: FmsState, number: number | null): string {
	if (!number) return "";
	return state.teams.find((t) => t.number === number)?.name ?? "";
}

const LEVEL_LABEL: Record<string, string> = {
	Level6: "Round 1",
	Level5: "Round 2",
	Level4: "Round 3",
	Level3: "Round 4",
	Level2: "Round 5",
	Final: "Finals",
};

// #endregion

export function AllianceSelection({ state }: { state: FmsState }) {
	const active = state.allianceSelection?.active ?? false;
	const slot = currentSlot(state);
	const available = state.rankings.filter((r) => r.pickStatus === "None" && !r.isDeclined);
	const declined = state.rankings.filter((r) => r.isDeclined);

	const slotLabel = slot ? `Alliance ${slot.alliance}, ${slot.round === 1 ? "first" : "second"} pick` : "selection complete";

	return (
		<div className="space-y-4">
			<Card title="Alliance Selection">
				<div className="mb-3 flex flex-wrap items-center gap-2">
					{!active ? (
						<Button variant="primary" onClick={() => control("/control/alliance/start")}>
							Start Alliance Selection
						</Button>
					) : (
						<>
							<span className="mr-2 text-sm text-slate-300">
								On the clock: <span className="font-semibold text-emerald-400">{slotLabel}</span>
							</span>
							<Button variant="ghost" onClick={() => control("/control/alliance/undo")}>
								Undo Last
							</Button>
							<Button variant="ghost" onClick={() => control("/control/alliance/skip")} disabled={!slot}>
								Skip
							</Button>
							<Button variant="primary" onClick={() => control("/control/alliance/save")}>
								Save Alliances
							</Button>
						</>
					)}
				</div>

				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="text-left text-xs uppercase tracking-wide text-slate-500">
								<th className="px-2 py-1">Alliance</th>
								<th className="px-2 py-1">Captain</th>
								<th className="px-2 py-1">First pick</th>
								<th className="px-2 py-1">Second pick</th>
							</tr>
						</thead>
						<tbody>
							{state.alliances.map((a) => {
								const cell = (round: 1 | 2, num: number | null) => {
									const current = slot?.alliance === a.allianceNumber && slot.round === round;
									return (
										<td
											className={`rounded px-2 py-1 ${current ? "bg-emerald-600/30 ring-1 ring-emerald-500" : ""}`}
										>
											{num ? (
												<span>
													<span className="font-semibold text-white">{num}</span>{" "}
													<span className="text-slate-400">{teamName(state, num)}</span>
												</span>
											) : current ? (
												<span className="text-emerald-400">pick now</span>
											) : (
												<span className="text-slate-600">-</span>
											)}
										</td>
									);
								};
								return (
									<tr key={a.allianceNumber} className="border-t border-slate-800">
										<td className="px-2 py-1 font-semibold text-slate-300">{a.allianceNumber}</td>
										<td className="px-2 py-1">
											<span className="font-semibold text-white">{a.captainTeamNumber ?? "-"}</span>{" "}
											<span className="text-slate-400">{teamName(state, a.captainTeamNumber)}</span>
										</td>
										{cell(1, a.firstRoundTeamNumber)}
										{cell(2, a.secondRoundTeamNumber)}
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</Card>

			<div className="grid gap-4 md:grid-cols-2">
				<Card title={`Available teams (${available.length})`}>
					{available.length === 0 ? (
						<p className="text-sm text-slate-500">No teams available.</p>
					) : (
						<div className="max-h-80 space-y-1 overflow-y-auto">
							{available.map((r) => (
								<div key={r.teamNumber} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-slate-800/60">
									<span className="w-8 text-right text-xs text-slate-500">#{r.rank}</span>
									<span className="font-semibold text-white">{r.teamNumber}</span>
									{r.inPotentialCaptainPosition && (
										<span className="rounded bg-sky-600/30 px-1 text-[10px] text-sky-300">capt</span>
									)}
									<span className="flex-1 truncate text-slate-400">{teamName(state, r.teamNumber)}</span>
									<Button
										variant="primary"
										disabled={!active || !slot}
										onClick={() => control("/control/alliance/pick", { teamNumber: r.teamNumber })}
									>
										Accept
									</Button>
									<Button
										variant="ghost"
										disabled={!active}
										onClick={() => control("/control/alliance/decline", { teamNumber: r.teamNumber, on: true })}
									>
										Decline
									</Button>
								</div>
							))}
						</div>
					)}
				</Card>

				<Card title={`Declined (${declined.length})`}>
					{declined.length === 0 ? (
						<p className="text-sm text-slate-500">No declines.</p>
					) : (
						<div className="space-y-1">
							{declined.map((r) => (
								<div key={r.teamNumber} className="flex items-center gap-2 rounded px-2 py-1">
									<span className="font-semibold text-slate-400 line-through">{r.teamNumber}</span>
									<span className="flex-1 truncate text-slate-600 line-through">{teamName(state, r.teamNumber)}</span>
									<Button
										variant="ghost"
										onClick={() => control("/control/alliance/decline", { teamNumber: r.teamNumber, on: false })}
									>
										Undo decline
									</Button>
								</div>
							))}
						</div>
					)}
				</Card>
			</div>

			<Bracket state={state} />
		</div>
	);
}

// #region bracket

function Bracket({ state }: { state: FmsState }) {
	const matches = Object.values(state.playoffMatches).sort((a, b) => a.matchNumber - b.matchNumber);
	const level = state.bracket?.currentLevel ?? "None";
	const allianceLabel = (n: number | null): string => (n ? `A${n}` : "-");

	return (
		<Card title={`Playoff bracket - ${LEVEL_LABEL[level] ?? level}`}>
			<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
				{matches.map((m) => {
					const name = m.matchNumber <= 13 ? `M${m.matchNumber}` : `F${m.matchNumber - 13}`;
					const redWin = m.winner === "Red";
					const blueWin = m.winner === "Blue";
					return (
						<div key={m.matchNumber} className="rounded border border-slate-700 bg-slate-900/50 p-2 text-sm">
							<div className="mb-1 text-xs uppercase tracking-wide text-slate-500">{name}</div>
							<div className={`flex justify-between ${redWin ? "font-semibold text-red-400" : "text-slate-300"}`}>
								<span>{allianceLabel(m.red)}</span>
								<span>{m.complete ? m.redScore : ""}</span>
							</div>
							<div className={`flex justify-between ${blueWin ? "font-semibold text-sky-400" : "text-slate-300"}`}>
								<span>{allianceLabel(m.blue)}</span>
								<span>{m.complete ? m.blueScore : ""}</span>
							</div>
						</div>
					);
				})}
			</div>
		</Card>
	);
}

// #endregion
