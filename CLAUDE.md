# Fake FMS

FRC Field Management System emulator for testing FTA-Buddy and the audience-display package
without a real field. Runs as a Docker container at `10.0.100.5` (macvlan) where both apps
expect FMS. Bun + TypeScript + React.

## Architecture

Bun workspace, three packages:

- `packages/shared` - wire types copied byte-for-byte from the consumers (FTA-Buddy
  `shared/types.ts` + `fmsApiTypes.ts`; audience-display `packages/lib/types/*`) plus the
  swappable game-module interface (`src/games`). No runtime deps.
- `packages/server` - the emulator. Two `Bun.serve` instances:
  - FMS server on `:80` - SignalR hubs + REST (what the consumers hit).
  - control server on `:3010` - control REST API + state websocket + serves the built UI.
- `packages/ui` - React + Vite control panel.

## Key invariants (do not break)

- **SignalR is hand-rolled** (`server/src/signalr/`). Both consumers use `@microsoft/signalr`
  (ASP.NET Core SignalR JSON protocol over WebSocket). Frames are JSON + `0x1e` separator;
  message types: 1 invocation, 3 completion, 6 ping, 7 close. Negotiate returns
  `{connectionId, connectionToken, negotiateVersion:1, availableTransports:[WebSockets]}`.
- **Emit PascalCase** SignalR `target` names AND PascalCase payload keys. The client lowercases
  only the target for handler dispatch, so `MatchStatusInfoChanged` matches
  `connection.on("matchstatusinfochanged")`. Payload keys must match the consumer's reads exactly.
- **Quoted-string REST endpoints** return `JSON.stringify(value)` (with the literal quotes) -
  see `http.ts` `quoted()`. Consumers strip the quotes.
- `get_CurrentlyActiveEventCode` returns the **bare** code (no year); FTA-Buddy prepends the year.
- ftaAppHub emits action-specific events (`NoteAdded`/`NoteUpdated`/`NoteResolved`/`NoteReopened`/
  `NoteDeleted`) carrying the note record - NOT a generic `NoteChanged`.

## Data flow

`FmsStore` (server/src/state/store.ts) is the single source of truth (in-memory, seeded by
`state/seed.ts`). Mutations emit typed `StoreEvents`; `fanout.ts` is the ONLY place mapping a
domain event to SignalR broadcasts. `index.ts` pushes the full state to the control UI over a
websocket on every `stateChanged`. The match lifecycle + timer engine is `match/controller.ts`.

## Commands

```bash
bun install
FMS_PORT=18080 CONTROL_PORT=3010 bun run server   # :80 needs root; override for local dev
bun run ui                                          # Vite on :5173, proxies control to :3010
bun run dev                                         # both
bun run build                                       # UI -> packages/ui/dist
SMOKE_FMS_PORT=18080 SMOKE_CONTROL_PORT=3010 bun run smoke   # e2e via @microsoft/signalr
```

Typecheck a package: `cd packages/<pkg> && bun --bun x tsc --noEmit` (plain `bunx`/`tsc` hits
the ancient system Node; always use `bun --bun x`).

## Deploy

`docker compose up -d --build` with a `10.0.100.0/24` macvlan; see NETWORKING.md (UniFi VLAN +
host VLAN sub-interface + laptop route). Healthcheck is `GET /FieldMonitor`.

## Adding a game season

Implement `GameModule<TScore>` in `packages/shared/src/games/<id>.ts`, register it in
`registry.ts`. The score editor renders generically from the module's `editorSchema`.
