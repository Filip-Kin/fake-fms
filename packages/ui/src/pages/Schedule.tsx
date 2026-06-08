import type { FmsState } from "shared";
import { Card } from "../components/ui";

export function Schedule({ state }: { state: FmsState }) {
	return (
		<Card title={`Schedule (${state.schedule.length} matches)`}>
			<div className="overflow-x-auto">
				<table className="w-full text-left text-sm">
					<thead className="text-xs uppercase text-slate-500">
						<tr>
							<th className="py-1">Match</th>
							<th className="py-1">Level</th>
							<th className="py-1 text-red-400">Red</th>
							<th className="py-1 text-sky-400">Blue</th>
							<th className="py-1">Status</th>
							<th className="py-1">Score</th>
						</tr>
					</thead>
					<tbody>
						{state.schedule.map((m) => (
							<tr key={m.fmsMatchId} className="border-t border-slate-800">
								<td className="py-1 font-medium">{m.matchNumber}</td>
								<td className="py-1 text-slate-400">{m.level}</td>
								<td className="py-1 text-red-300">{m.red.join(", ")}</td>
								<td className="py-1 text-sky-300">{m.blue.join(", ")}</td>
								<td className="py-1 text-slate-400">{m.status}</td>
								<td className="py-1 text-slate-400">
									{m.finalScoreRed != null ? `${m.finalScoreRed} - ${m.finalScoreBlue}` : "-"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Card>
	);
}
