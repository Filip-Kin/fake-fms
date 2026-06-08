import { useState } from "react";
import type { FmsState } from "shared";
import { control } from "../api";
import { Button, Card, NumberInput, TextInput } from "../components/ui";

export function Teams({ state }: { state: FmsState }) {
	const [number, setNumber] = useState(0);
	const [name, setName] = useState("");

	return (
		<Card title={`Teams (${state.teams.length})`}>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<NumberInput value={number} onChange={setNumber} />
				<TextInput value={name} onChange={setName} placeholder="Team name" />
				<Button
					variant="primary"
					onClick={() => {
						if (number > 0) control("/control/team/add", { number, name });
						setNumber(0);
						setName("");
					}}
				>
					Add team
				</Button>
				<Button variant="ghost" onClick={() => control("/control/wpa/generate")}>
					Regenerate all WPA keys
				</Button>
			</div>

			<div className="overflow-x-auto">
				<table className="w-full text-left text-sm">
					<thead className="text-xs uppercase text-slate-500">
						<tr>
							<th className="py-1">#</th>
							<th className="py-1">Name</th>
							<th className="py-1">WPA key</th>
							<th className="py-1"></th>
						</tr>
					</thead>
					<tbody>
						{state.teams.map((t) => (
							<tr key={t.number} className="border-t border-slate-800">
								<td className="py-1 font-medium">{t.number}</td>
								<td className="py-1 text-slate-300">{t.name}</td>
								<td className="py-1 font-mono text-xs text-slate-500">{t.wpaKey}</td>
								<td className="py-1 text-right">
									<Button
										variant="ghost"
										className="!px-2 !py-0.5 !text-xs"
										onClick={() => control("/control/wpa/generate", { number: t.number })}
									>
										New key
									</Button>
									<Button
										variant="danger"
										className="!ml-1 !px-2 !py-0.5 !text-xs"
										onClick={() => control("/control/team/remove", { number: t.number })}
									>
										Remove
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Card>
	);
}
