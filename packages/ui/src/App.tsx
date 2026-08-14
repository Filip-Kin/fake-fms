import { useState } from "react";
import type { FmsState } from "shared";
import { control, useFmsState } from "./api";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { Toggle } from "./components/ui";
import { AllianceSelection } from "./pages/AllianceSelection";
import { EventSetup } from "./pages/EventSetup";
import { Faults } from "./pages/Faults";
import { FieldMonitor } from "./pages/FieldMonitor";
import { MatchControl } from "./pages/MatchControl";
import { ScoreEditor } from "./pages/ScoreEditor";
import { Schedule } from "./pages/Schedule";
import { Teams } from "./pages/Teams";
import { TestSequence } from "./pages/TestSequence";

const TABS = ["Match", "Test", "Field Monitor", "Scores", "Alliances", "Faults", "Event", "Teams", "Schedule"] as const;
type Tab = (typeof TABS)[number];

export function App() {
	const { state, connected } = useFmsState();
	const [tab, setTab] = useState<Tab>("Match");

	if (!state) {
		return (
			<div className="flex h-screen items-center justify-center text-slate-400">
				{connected ? "Loading state..." : "Connecting to Fake FMS..."}
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-6xl p-4">
			<header className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="text-xl font-bold text-white">Fake FMS</h1>
					<p className="text-xs text-slate-400">
						{state.event.name} ({state.event.season}
						{state.event.code}) - {state.current.matchState}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-4">
					<div
						className={`flex items-center gap-2 rounded-md border px-3 py-1.5 ${
							state.caEnabled ? "border-purple-500/60 bg-purple-500/10" : "border-slate-700"
						}`}
						title="Emulate a Team254 Cheesy Arena field on http://<host>:8080 (HTTP + WebSocket notifier feed) alongside FMS."
					>
						<Toggle
							on={state.caEnabled}
							onChange={(v) => void control("/control/ca/mode", { on: v })}
							label="Cheesy Arena"
						/>
						<span className={`text-xs ${state.caEnabled ? "text-purple-300" : "text-slate-500"}`}>
							{state.caEnabled ? ":8080 live" : "off"}
						</span>
					</div>
					<ConnectionStatus clients={state.clients} connected={connected} />
				</div>
			</header>

			<nav className="mb-4 flex flex-wrap gap-1 border-b border-slate-700">
				{TABS.map((t) => (
					<button
						key={t}
						onClick={() => setTab(t)}
						className={`px-3 py-2 text-sm font-medium transition ${
							tab === t ? "border-b-2 border-emerald-500 text-white" : "text-slate-400 hover:text-slate-200"
						}`}
					>
						{t}
					</button>
				))}
			</nav>

			<main>
				<TabBody tab={tab} state={state} />
			</main>
		</div>
	);
}

function TabBody({ tab, state }: { tab: Tab; state: FmsState }) {
	switch (tab) {
		case "Match":
			return <MatchControl state={state} />;
		case "Test":
			return <TestSequence state={state} />;
		case "Field Monitor":
			return <FieldMonitor state={state} />;
		case "Scores":
			return <ScoreEditor state={state} />;
		case "Alliances":
			return <AllianceSelection state={state} />;
		case "Faults":
			return <Faults state={state} />;
		case "Event":
			return <EventSetup state={state} />;
		case "Teams":
			return <Teams state={state} />;
		case "Schedule":
			return <Schedule state={state} />;
		default:
			return null;
	}
}
