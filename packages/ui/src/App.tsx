import { useState } from "react";
import type { FmsState } from "shared";
import { useFmsState } from "./api";
import { ConnectionStatus } from "./components/ConnectionStatus";
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
				<ConnectionStatus clients={state.clients} connected={connected} />
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
