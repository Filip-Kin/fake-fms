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

Besides FMS, the same store can present as a full [Team254 Cheesy Arena](https://github.com/Team254/cheesy-arena)
field. Flip the **Cheesy Arena** switch in the control UI header (or `POST /control/ca/mode {"on":true}`)
and a third server on **:8080** goes live, serving CA's **complete** HTTP + WebSocket surface. The FMS
SignalR/REST surface keeps running the whole time — the toggle only gates the CA server; when it is off,
:8080 answers 503.

What it serves (`packages/server/src/ca/`, the CA analogue of `fanout.ts`/`rest`, over the **same**
`FmsStore` + match controller so the CA and FMS feeds always agree):

- **REST** — `/api/matches/{type}`, `/api/rankings`, `/api/alliances`, `/api/sponsor_slides`,
  `/api/teams/{id}/avatar`, `/api/bracket/svg` (rendered from CA's `bracket.svg` geometry), and
  `/api/arena/websocket`.
- **Every display/panel/setup web page** (`/`, `/displays/*`, `/match_play`, `/panels/*`, `/setup/*`,
  `/match_review`, `/match_logs`, the HTML partials) reflecting live state.
- **All `/reports/*`** — CSV byte-accurate to CA's templates, plus real generated PDFs.
- **The notifier websockets** for field_monitor, audience, announcer, alliance_station, queueing,
  rankings, bracket, logo/twitch/wall/webpage, match_play, scoring, referee, alliance_selection, the
  setup sockets, and `/api/arena/websocket` — each with CA's exact subscription set, bootstrap order,
  and 10 s ping.
- **Notifiers**: arenaStatus, matchLoad, matchTime, matchTiming, eventStatus, realtimeScore (with live
  Hub active-shift timing), scorePosted, displayConfiguration, audienceDisplayMode (all ten CA modes,
  driven through the real intro→match→blank→score sequence), allianceStationDisplayMode, scoringStatus,
  allianceSelection, lowerThird, playSound (start/warning/end/abort/match_result/shift_change), reload.
- **All client commands**: match_play (load/substitute/bypass/start/abort/commitAndPost/discard/
  timeout/audience-display/…), scoring (autoTower/endgame/addFoul/commitMatch → live score), referee
  (fouls/cards/commit), alliance_selection (timer), setup/displays (reload), setup/lower_thirds,
  setup/field_testing.
- **Timeouts** (TimeoutActive/PostTimeout with the timeout clock) and **playoffs** (matchLoad.Matchup,
  off-field teams, the double-elimination bracket).

Wire fidelity is transcribed from a real CA instance (see `ca-docs/`): flat `MatchWithResult` on
`/api/matches` (no `Match` wrapper), integer enums, PascalCase keys, exact bootstrap order, `scorePosted`
deliberately **absent** from the field-monitor feed, and a **no-PLC** field model (`arenaStatus` reports
`UNKNOWN` component statuses, `PlcIsHealthy` false, `FieldEStop` true, four all-false
`PlcArmorBlockStatuses` keys). Remaining approximations: the per-alliance game **score** maps the
fake-fms 2026 point model onto CA's Hub/Tower/Fuel structs structurally (not byte-for-byte CA scoring);
the web pages are functional state views, not CA's exact operator UI; PDF reports carry the right data
but aren't byte-identical to CA's gofpdf output; and `match_play` match IDs are synthetic (Practice
1000+, Qual 2000+, Playoff 3000+) — take IDs from `/api/matches`, not CA's DB ids.

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
