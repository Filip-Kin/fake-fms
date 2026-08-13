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

## Cheesy Arena emulation

Besides FMS, the same store can present as a [Team254 Cheesy Arena](https://github.com/Team254/cheesy-arena)
field. Flip the **Cheesy Arena** switch in the control UI header (or `POST /control/ca/mode {"on":true}`)
and a third server on **:8080** goes live, serving CA's HTTP + WebSocket-notifier surface: the `/api/*`
JSON endpoints (`/api/matches/{type}`, `/api/rankings`, `/api/alliances`, `/api/teams/{id}/avatar`,
`/api/bracket/svg`), the display/panel websockets (`/displays/field_monitor/websocket`, `audience`,
`announcer`, `match_play`, …), and the notifier stream (`arenaStatus`, `matchLoad`, `matchTime`,
`eventStatus`, `realtimeScore`, `scorePosted`, …). The FMS SignalR/REST surface keeps running the whole
time — the toggle only gates the CA server; when it is off, :8080 answers 503.

It projects the **same** `FmsStore` and match controller (`packages/server/src/ca`, the CA analogue of
`fanout.ts`/`rest`), so the CA feed and FMS feed always agree. Wire fidelity is transcribed from a real
CA instance (see the `ca-docs/` reference): flat `MatchWithResult` on `/api/matches` (no `Match`
wrapper), integer enums, PascalCase keys, the exact bootstrap order, and `scorePosted` deliberately
**absent** from the field-monitor feed. Known approximations: the per-alliance game score
(`realtimeScore`/`Result`) maps the fake-fms 2026 point model onto CA's Hub/Tower/Fuel structs
structurally rather than byte-for-byte; `/api/bracket/svg` is a placeholder; CA match sounds
(`playSound`) are not emitted.

## Packages

| Package           | What                                                           |
| ----------------- | -------------------------------------------------------------- |
| `packages/shared` | Wire types (byte-compatible with both consumers), game modules |
| `packages/server` | The emulator: SignalR hubs + REST on :80, control API on :3010 |
| `packages/ui`     | React + Vite control panel (served from :3010 in production)   |

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

## Run it on your laptop (no field network)

If you just want a working FMS at `10.0.100.5` on your own machine to develop against (Linux or
macOS), you do **not** need the macvlan/field-network setup. You need Docker installed, then:

```bash
git clone <this repo> && cd fake-fms
./scripts/dev-up.sh        # adds a 10.0.100.5 loopback alias (one sudo prompt), builds, starts
```

That's it. The emulator is now reachable from the same laptop at:

- FMS API + SignalR: `http://10.0.100.5`
- Control console: `http://10.0.100.5:3010`

Point FTA-Buddy / audience-display at `10.0.100.5` as usual and drive matches from the control
console. Stop it with `./scripts/dev-down.sh`. No `.env` or TBA key is required (it seeds realistic
demo teams + schedule); set `TBA_API_KEY` in a gitignored `.env` to pull a real event instead.

How it works: `docker-compose.dev.yml` publishes the container's ports onto a `10.0.100.5` loopback
alias the script adds, so traffic to `10.0.100.5` stays on your machine. The alias is not persistent
across reboots, so re-run `dev-up.sh` after restarting.

## Production deploy (the real field network)

For the home-server deploy where the container owns the real `10.0.100.5` on the field VLAN:

```bash
bun run build                       # builds the UI into packages/ui/dist
docker compose up -d --build        # macvlan; see NETWORKING.md for the host VLAN + UniFi setup
```

- FMS API + SignalR: `http://10.0.100.5:80`
- Control UI: `http://10.0.100.5:3010`

## Drive it from Claude (MCP)

The emulator ships an MCP server so an AI agent can run matches, score, cycle the field monitor,
and read live state while you develop. Two ways to connect:

**Networked (no local repo).** The running container hosts the MCP server over Streamable HTTP at
`/mcp` on the control port, so a remote Claude Code just points at the URL:

```bash
claude mcp add --transport http fake-fms http://10.0.100.5:3010/mcp
```

That's all the laptop needs, no clone, no `bun`. (For a local laptop deploy via `dev-up.sh`, the URL
is the same `http://10.0.100.5:3010/mcp`.)

**Local (stdio).** A clone of the repo also exposes the server over stdio; the repo's `.mcp.json`
auto-registers it for Claude Code run inside the repo. Point it at any emulator with
`FAKE_FMS_CONTROL_URL` (default the deployed field box).

## Ports / env

| Env                    | Default       | Meaning                                         |
| ---------------------- | ------------- | ----------------------------------------------- |
| `FMS_PORT`             | `80`          | FMS REST + SignalR port                         |
| `CONTROL_PORT`         | `3010`        | Control API + UI + state ws + `/mcp` port       |
| `CA_PORT`              | `8080`        | Cheesy Arena emulation port (gated by toggle)   |
| `GAME_ID`              | `rebuilt2026` | Active game scoring module                      |
| `FAKE_FMS_CONTROL_URL` | (control URL) | MCP server: which emulator control API to drive |
