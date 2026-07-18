import { useEffect, useState } from "react";
import type { FmsState, TournamentLevel } from "shared";
import { control } from "../api";
import { Button, Card, TextInput } from "../components/ui";

const LEVELS: TournamentLevel[] = ["None", "Practice", "Qualification", "Playoff"];

export function EventSetup({ state }: { state: FmsState }) {
	const [name, setName] = useState(state.event.name);
	const [code, setCode] = useState(state.event.code);
	const [password, setPassword] = useState(state.event.fmsEventPassword);
	const [games, setGames] = useState<{ id: string; season: number }[]>([]);

	useEffect(() => {
		fetch("/games")
			.then((r) => r.json())
			.then(setGames)
			.catch((err) => {
				console.error("[games] failed to load game module list:", err);
				setGames([]);
			});
	}, []);

	return (
		<div className="grid gap-4 md:grid-cols-2">
			<Card title="Event">
				<div className="space-y-3 text-sm">
					<Labeled label="Name">
						<TextInput value={name} onChange={setName} className="w-full" />
					</Labeled>
					<Labeled label="Event code (no year)">
						<TextInput value={code} onChange={setCode} className="w-full" />
					</Labeled>
					<Labeled label="FMS event password (Notes token)">
						<TextInput value={password} onChange={setPassword} className="w-full" />
					</Labeled>
					<Button
						variant="primary"
						onClick={() => control("/control/event", { name, code, fmsEventPassword: password })}
					>
						Save event
					</Button>
				</div>
			</Card>

			<Card title="Tournament level">
				<div className="flex flex-wrap gap-2">
					{LEVELS.map((l) => (
						<Button
							key={l}
							variant={state.event.level === l ? "primary" : "ghost"}
							onClick={() => control("/control/level", { level: l })}
						>
							{l}
						</Button>
					))}
				</div>
			</Card>

			<Card title="Game module">
				<div className="flex flex-wrap gap-2">
					{games.map((g) => (
						<Button
							key={g.id}
							variant={state.gameModuleId === g.id ? "primary" : "ghost"}
							onClick={() => control("/control/game", { id: g.id })}
						>
							{g.id} ({g.season})
						</Button>
					))}
				</div>
				<p className="mt-2 text-xs text-slate-500">Switching modules resets scores and game config.</p>
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
