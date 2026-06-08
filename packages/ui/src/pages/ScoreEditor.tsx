import { type FmsState, getGameModule, type ScoreFieldDescriptor } from "shared";
import { control } from "../api";
import { Button, Card, NumberInput, Toggle } from "../components/ui";

const GROUPS: ScoreFieldDescriptor["group"][] = ["auto", "teleop", "endgame", "penalty"];

export function ScoreEditor({ state }: { state: FmsState }) {
	const module = getGameModule(state.gameModuleId);
	const schema = module.editorSchema;

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-slate-400">
					Game module: <span className="text-slate-200">{module.id}</span>
				</p>
				<Button variant="ghost" onClick={() => control("/control/score/reset")}>
					Reset scores
				</Button>
			</div>
			<div className="grid gap-4 md:grid-cols-2">
				<AllianceColumn alliance="Red" state={state} schema={schema} />
				<AllianceColumn alliance="Blue" state={state} schema={schema} />
			</div>
		</div>
	);
}

function AllianceColumn({
	alliance,
	state,
	schema,
}: {
	alliance: "Red" | "Blue";
	state: FmsState;
	schema: ScoreFieldDescriptor[];
}) {
	const score = alliance === "Red" ? state.score.red : state.score.blue;
	const total = Number(score.totalPoints ?? 0);
	const color = alliance === "Red" ? "text-red-400" : "text-sky-400";

	return (
		<Card title={`${alliance} Alliance`}>
			<div className={`mb-3 text-3xl font-bold ${color}`}>{total} pts</div>
			{GROUPS.map((group) => {
				const fields = schema.filter((f) => f.group === group);
				if (fields.length === 0) return null;
				return (
					<div key={group} className="mb-3">
						<h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">{group}</h4>
						<div className="space-y-1">
							{fields.map((f) => (
								<Field key={f.key} alliance={alliance} field={f} value={score[f.key]} />
							))}
						</div>
					</div>
				);
			})}
		</Card>
	);
}

function Field({
	alliance,
	field,
	value,
}: {
	alliance: "Red" | "Blue";
	field: ScoreFieldDescriptor;
	value: unknown;
}) {
	const set = (v: number | boolean) => control("/control/score", { alliance, key: field.key, value: v });
	return (
		<div className="flex items-center justify-between">
			<span className="text-sm text-slate-300">{field.label}</span>
			{field.kind === "boolean" ? (
				<Toggle on={Boolean(value)} onChange={set} />
			) : (
				<NumberInput value={Number(value ?? 0)} onChange={set} />
			)}
		</div>
	);
}
