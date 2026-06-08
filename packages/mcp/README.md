# Fake FMS MCP server

Lets an AI agent (Claude Code, etc.) **drive the Fake FMS emulator** while you develop against it.
Each tool is a thin bridge to the emulator's control API (the same endpoints the React panel uses).

## Tools

- `get_state` - compact snapshot: event, current match, timer/phase, per-station status, score totals, connected SignalR clients
- `list_matches` - matches in the current level (number, play, teams)
- `select_match` / `prestart` / `set_audience` / `arm_match` / `start_match` / `commit_scores` / `post_results` / `next_match` / `abort_match` - full match lifecycle
- `set_score` / `reset_scores` - game-specific scoring
- `cycle_station` / `set_station_flag` (bypass/estop/astop) / `reset_stations` - field monitor
- `set_level` - switch tournament level

A typical run: `select_match` -> `prestart` -> `set_audience` -> `arm_match` -> `start_match` -> wait
-> `set_score` (as needed) -> `commit_scores` -> `post_results` -> `next_match`.

## Config

It talks to the emulator's **control port** via `FAKE_FMS_CONTROL_URL` (default `http://10.0.100.5:3010`,
the deployed field box). For a local emulator, set it to e.g. `http://localhost:3010`.

The repo ships a `.mcp.json` so Claude Code picks it up automatically when you work in this project.
To register it manually elsewhere:

```bash
claude mcp add fake-fms -- bun run /path/to/fake-fms/packages/mcp/src/index.ts
# then set FAKE_FMS_CONTROL_URL in the server's env if not the default
```

Run standalone (stdio):

```bash
FAKE_FMS_CONTROL_URL=http://localhost:3010 bun run packages/mcp/src/index.ts
```
