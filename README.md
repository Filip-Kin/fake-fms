# Fake FMS

An FRC Field Management System emulator for testing **FTA-Buddy** and the **audience-display**
package without a real field. It speaks the same SignalR Core hubs + REST API the real FMS
exposes at `10.0.100.5`, and gives you a React control panel to drive an event: create teams,
generate WPA keys, run matches with timers, bypass / e-stop / a-stop robots, edit game-specific
scores, and click a field-monitor grid to cycle each robot's connection status. Every change
fans out the correct SignalR events and updates the REST responses.

## How it works

- Both consumers use the `@microsoft/signalr` client, i.e. the ASP.NET Core SignalR JSON
  protocol over WebSocket. The server hand-rolls that protocol (`packages/server/src/signalr`),
  so no .NET is involved.
- A single in-memory `FmsStore` is the source of truth. Mutations emit typed domain events;
  `fanout.ts` maps each to the right SignalR broadcast; the control UI gets a full-state push
  over a websocket.
- Game-specific scoring is a swappable module (`packages/shared/src/games`); the default targets
  the 2026 season.

## Packages

| Package           | What                                                              |
| ----------------- | ---------------------------------------------------------------- |
| `packages/shared` | Wire types (byte-compatible with both consumers), game modules   |
| `packages/server` | The emulator: SignalR hubs + REST on :80, control API on :3010   |
| `packages/ui`     | React + Vite control panel (served from :3010 in production)     |

## Develop

```bash
bun install

# run server (FMS :80 needs root locally; override the ports for dev):
FMS_PORT=18080 CONTROL_PORT=3010 bun run server
# in another shell, the UI with hot reload (proxies control API to :3010):
bun run ui            # http://localhost:5173

# or run both together:
bun run dev
```

### Smoke test

Connects with the real `@microsoft/signalr` client and drives a full match flow:

```bash
FMS_PORT=18080 CONTROL_PORT=3010 bun run server &
SMOKE_FMS_PORT=18080 SMOKE_CONTROL_PORT=3010 bun run smoke
```

## Build & deploy

```bash
bun run build                       # builds the UI into packages/ui/dist
docker compose up -d --build        # see NETWORKING.md for the 10.0.100.5 macvlan setup
```

- FMS API + SignalR: `http://10.0.100.5:80`
- Control UI: `http://10.0.100.5:3010`

## Ports / env

| Env            | Default          | Meaning                          |
| -------------- | ---------------- | -------------------------------- |
| `FMS_PORT`     | `80`             | FMS REST + SignalR port          |
| `CONTROL_PORT` | `3010`           | Control API + UI + state ws port |
| `GAME_ID`      | `reefscape2026`  | Active game scoring module       |
