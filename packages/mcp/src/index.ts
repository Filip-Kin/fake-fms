// Stdio entry point for the Fake FMS MCP server. Use this when running the MCP server locally from
// a clone of the repo (the repo's `.mcp.json` launches it this way). For a networked server that a
// remote Claude Code can point at with no local copy, the emulator hosts `http.ts` at
// http://<host>:3010/mcp instead.
//
// Point it at a running emulator with FAKE_FMS_CONTROL_URL (the control port; default the deployed
// field box).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

const server = buildServer(process.env.FAKE_FMS_CONTROL_URL ?? "http://10.0.100.5:3010");
const transport = new StdioServerTransport();
await server.connect(transport);
