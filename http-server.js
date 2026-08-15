#!/usr/bin/env node
// Mektup MCP server - remote HTTP entrypoint (Streamable HTTP transport).
// One shared process serves every account: unlike server.js (stdio, one
// process per local user with one fixed MEKTUP_API_KEY), this reads the
// caller's own API key from the Authorization header on each request, so
// tenant isolation is exactly the API's own (RLS scoped by that key) - this
// process holds no account-specific credential itself.
//
// Stateless per the MCP Streamable HTTP spec (sessionIdGenerator: undefined):
// no session state is kept between requests, matching how every tool call
// here is already a one-shot passthrough to the REST API. A fresh
// McpServer + transport is built per request and torn down when it ends.
//
// What this lets external platforms (Lovable, Cursor, Replit, Base44, ...)
// do: point their "custom MCP server" connector at this URL. Two auth modes
// arrive as the exact same "Authorization: Bearer <token>" header and both
// just get forwarded as-is to the REST API, which is the only place that
// actually distinguishes them (api/auth.js requireAuth()):
//   - a Mektup API key (mek_live_...) - manual copy-paste, works today
//   - a Clerk-issued OAuth access token, from the "connect" flow below - no
//     token copy-paste, the platform's user signs in and approves instead.
// This file never needs to know which one it got, or verify either itself -
// same passthrough either way. The only OAuth-specific thing here is
// advertising WHERE to get such a token (Clerk, as the authorization
// server) via RFC 9728 protected-resource metadata, so a client that only
// has this URL can discover the rest on its own instead of being hardcoded
// to it out of band.
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createMektupServer } from "./lib/build-server.js";

const PORT = process.env.MCP_HTTP_PORT || 4200;
const API_BASE = process.env.MEKTUP_API_BASE_URL || "https://api.usemektup.com";
const MCP_PUBLIC_URL = new URL(process.env.MCP_PUBLIC_URL || "https://mcp.usemektup.com/mcp");
const CLERK_ISSUER_URL = process.env.CLERK_ISSUER_URL || "https://clerk.usemektup.com";
const RESOURCE_METADATA_URL = getOAuthProtectedResourceMetadataUrl(MCP_PUBLIC_URL);

const app = express();
app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"] }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Clerk is the authorization server; this process is only ever a resource
// server (it never issues or validates tokens itself - see the header
// comment above). Fetched once at boot rather than hand-copied, so a Clerk
// config change is picked up on the next restart instead of silently
// drifting from a hardcoded copy. A startup failure here is fatal - serving
// stale/absent auth-server metadata is worse than not starting.
async function loadClerkOAuthMetadata() {
  const res = await fetch(`${CLERK_ISSUER_URL}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`Fetching Clerk OAuth metadata failed: HTTP ${res.status}`);
  return res.json();
}
const clerkOAuthMetadata = await loadClerkOAuthMetadata();

// Serves /.well-known/oauth-protected-resource/mcp (points clients at Clerk)
// and /.well-known/oauth-authorization-server (a same-origin mirror of
// Clerk's own, for clients that only check the resource server's copy).
app.use(mcpAuthMetadataRouter({
  oauthMetadata: clerkOAuthMetadata,
  resourceServerUrl: MCP_PUBLIC_URL,
  resourceName: "Mektup",
  scopesSupported: clerkOAuthMetadata.scopes_supported,
}));

function extractBearer(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// One request, one ephemeral server+transport pair - see file header. Errors
// from a missing/invalid token surface as a normal Mektup API 401 on the
// first tool call (call() in build-server.js), same message a direct REST
// caller would get; we only short-circuit here when the header is missing
// entirely, since that's a transport-level auth failure, not something a
// tool call should have to report. The WWW-Authenticate header is what lets
// an OAuth-capable MCP client discover Clerk on its own from just this URL,
// per RFC 9728 - a client that already has an API key ignores it.
app.post("/mcp", async (req, res) => {
  const apiKey = extractBearer(req);
  if (!apiKey) {
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`);
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Missing Authorization: Bearer <token> header (a Mektup API key, or an OAuth access token from Clerk)" },
      id: null,
    });
    return;
  }

  const server = createMektupServer(apiKey, API_BASE);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mektup-mcp-http: request failed", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode keeps no session to stream server-initiated notifications
// into or to close - a GET (open a standalone SSE stream) or DELETE (end a
// session) only make sense in stateful mode. 405 is the documented response
// for a Streamable HTTP server that doesn't support them.
app.get("/mcp", (_req, res) => res.status(405).json({ error: "This server is stateless - GET /mcp (server-initiated stream) isn't supported." }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "This server is stateless - there is no session to end." }));

app.listen(PORT, () => {
  console.log(`mektup-mcp-http listening on :${PORT}, forwarding to ${API_BASE}`);
});
