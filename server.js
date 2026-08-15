#!/usr/bin/env node
// Mektup MCP server - stdio entrypoint. One local process per user, bound to
// one MEKTUP_API_KEY. All tool definitions live in lib/build-server.js,
// shared with the remote HTTP entrypoint (http-server.js) - this file is
// just wiring: read the key, build the server, connect stdio.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMektupServer } from "./lib/build-server.js";

const API_BASE = process.env.MEKTUP_API_BASE_URL || "https://api.usemektup.com";
const API_KEY = process.env.MEKTUP_API_KEY;

if (!API_KEY) {
  console.error("MEKTUP_API_KEY is not set - add it to this MCP server's env config.");
  process.exit(1);
}

const server = createMektupServer(API_KEY, API_BASE);
const transport = new StdioServerTransport();
await server.connect(transport);
