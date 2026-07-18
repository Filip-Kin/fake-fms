import type { FmsState, TestSequenceStep } from "shared";
import { control } from "../api";
import { Button, Card } from "../components/ui";

/**
 * The audience-display test sequence: a guided walk through every screen and scoring
 * configuration the emulator can drive. Play the whole list back to back, or click any step to
 * jump straight to it and then resume. The current step is highlighted; the runner drives a
 * connected audience-display through each scenario.
 */
export function TestSequence({ state }: { state: FmsState }) {
	const { steps, currentIndex, running } = state.testSequence;
	const groups = groupSteps(steps);

	return (
		<div className="space-y-4">
			<Card title="Audience Display Test Sequence">
				<p className="mb-3 text-xs text-slate-400">
					Walks every audience-display screen and scoring configuration. Connect an audience-display to
					this emulator, then press Play to step through them all, or click any step to jump to it. The
					emulator drives FMS state; the audience-display renders the screens and plays the sounds.
				</p>
				<div className="flex flex-wrap items-center gap-2">
					{running ? (
						<Button variant="danger" onClick={() => control("/control/test/pause")}>
							Pause
						</Button>
					) : (
						<Button variant="primary" onClick={() => control("/control/test/play")}>
							{currentIndex >= 0 && currentIndex < steps.length - 1 ? "Resume" : "Play all"}
						</Button>
					)}
					<Button variant="neutral" onClick={() => control("/control/test/play", { from: 0 })}>
						Restart from top
					</Button>
					<span className="text-xs text-slate-500">
						{currentIndex >= 0 ? (
							<>
								Step {currentIndex + 1} / {steps.length}: {steps[currentIndex]?.label}
							</>
						) : (
							"Not started"
						)}
					</span>
				</div>
			</Card>

			{groups.map((g) => (
				<Card key={g.name} title={g.name}>
					<div className="space-y-1">
						{g.items.map(({ step, index }) => {
							const active = index === currentIndex;
							return (
								<button
									key={step.id}
									onClick={() => control("/control/test/goto", { index })}
									className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm transition ${
										active ? "bg-emerald-700 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"
									}`}
								>
									<span>
										<span className="mr-2 text-xs text-slate-400 tabular-nums">{index + 1}.</span>
										{step.label}
									</span>
									{active && (
										<span className={`text-xs ${running ? "text-emerald-200" : "text-slate-300"}`}>
											{running ? "● playing" : "showing"}
										</span>
									)}
								</button>
							);
						})}
					</div>
				</Card>
			))}
		</div>
	);
}

function groupSteps(steps: TestSequenceStep[]): { name: string; items: { step: TestSequenceStep; index: number }[] }[] {
	const groups: { name: string; items: { step: TestSequenceStep; index: number }[] }[] = [];
	steps.forEach((step, index) => {
		let g = groups.find((x) => x.name === step.group);
		if (!g) {
			g = { name: step.group, items: [] };
			groups.push(g);
		}
		g.items.push({ step, index });
	});
	return groups;
}
