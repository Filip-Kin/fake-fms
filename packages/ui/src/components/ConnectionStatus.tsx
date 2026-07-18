import type { HubClientCounts } from "shared";

const HUBS: { key: keyof HubClientCounts; label: string }[] = [
	{ key: "fieldMonitorHub", label: "field" },
	{ key: "infrastructureHub", label: "infra" },
	{ key: "gameSpecificHub", label: "game" },
	{ key: "ftaAppHub", label: "ftaApp" },
];

export function ConnectionStatus({ clients, connected }: { clients: HubClientCounts; connected: boolean }) {
	return (
		<div className="flex items-center gap-3 text-xs">
			<span className={`flex items-center gap-1 ${connected ? "text-emerald-400" : "text-red-400"}`}>
				<span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-red-400"}`} />
				control
			</span>
			{HUBS.map((h) => (
				<span key={h.key} className="flex items-center gap-1 text-slate-400">
					<span className={`h-2 w-2 rounded-full ${clients[h.key] > 0 ? "bg-emerald-400" : "bg-slate-600"}`} />
					{h.label} {clients[h.key]}
				</span>
			))}
		</div>
	);
}
