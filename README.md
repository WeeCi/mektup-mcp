# Mektup MCP Server

[Mektup](https://usemektup.com) is a fully-managed, multi-domain email platform - Mektup hosts all the mail infrastructure, so there's nothing to self-host; you just sign up and use it. This MCP server lets an AI coding agent (Claude Code, Claude Desktop, Cursor, Lovable, Replit, Base44, or any MCP-compatible client) manage real email for a domain — register it, add the DNS records, create mailboxes, send and read mail, manage drafts/contacts/folders/forwarding/vacation replies — as native tool calls inside its own session, instead of the human hand-writing `curl` commands or pasting an API key into generated code.

Every tool call is a straight HTTP call to the real [Mektup REST API](https://usemektup.com/docs/api.md). There's no separate logic to learn — if you understand the API, you understand the MCP server. **Full coverage**: every REST endpoint has a matching tool, verified with real read and write round-trips against the live production API (create → update → list → delete, confirmed at each step).

Two ways to run it, same tool set either way (`lib/build-server.js` defines the tools once, shared by both):

- **Remote (Streamable HTTP)** — a server we host at `https://mcp.usemektup.com/mcp`. Point any client that takes a "custom MCP server" URL at it directly, no install. This is what Lovable/Cursor/Replit/Base44-style platforms want.
- **Local (stdio)** — run `server.js` yourself with your key in an env var. For MCP clients that only support launching a local process (Claude Desktop config, etc.).

---

## Remote server (recommended for platform integrations)

**Endpoint:** `https://mcp.usemektup.com/mcp` (Streamable HTTP — supports both the direct-JSON-response and SSE-streaming response modes of the spec).

**Stateless:** no session is kept between requests — every tool call is already a one-shot passthrough to the REST API, so there's no session state worth keeping.

**Tenant isolation:** identical to the REST API, because it *is* the REST API underneath — the server holds no account-specific credential itself, it just forwards whichever token the caller sent (API key or OAuth access token, see below) straight through to `api.usemektup.com`, which is the only place that actually verifies it. A token only ever sees its own account's data.

Two auth modes, same endpoint, both arrive as the same `Authorization: Bearer <token>` header:

### OAuth (recommended for platform integrations)

For a platform with real end users (Lovable, Cursor, Replit, Base44, ...) — the user clicks "connect," signs in with their existing Mektup account, approves, done. No token copy-paste, no dashboard visit.

Clerk (`clerk.usemektup.com`) is the OAuth 2.1 authorization server — this MCP server is only ever a resource server. Discovery is automatic for any spec-compliant OAuth-capable MCP client: it only needs the endpoint URL above and finds the rest itself via `https://mcp.usemektup.com/.well-known/oauth-protected-resource/mcp` (RFC 9728), which points at Clerk's own `https://clerk.usemektup.com/.well-known/oauth-authorization-server` (RFC 8414). From there the client registers itself via Dynamic Client Registration (no manual setup needed on your end) and runs a standard Authorization Code + PKCE flow, ending with a JWT access token used exactly like an API key.

**Lovable:** Connectors → All → **Custom** (MCP card) → Server Name `Mektup`, Server URL `https://mcp.usemektup.com/mcp`, Auth → **OAuth** (default when a server supports it) → Add & authorize.

### API key (simplest for a single account, scripts, or a client without OAuth support)

`Authorization: Bearer mek_live_...` — create one at [app.usemektup.com](https://app.usemektup.com) → **API keys**.

Adding it to a client that supports custom MCP connectors is normally 3 fields:

| Field | Value |
|---|---|
| Server URL | `https://mcp.usemektup.com/mcp` |
| Auth type | Bearer token / API key |
| Token | your `mek_live_...` key |

**Cursor / Claude Desktop / any client that reads raw MCP JSON config:**
```json
{
  "mcpServers": {
    "mektup": {
      "url": "https://mcp.usemektup.com/mcp",
      "headers": { "Authorization": "Bearer mek_live_..." }
    }
  }
}
```

**Replit / Base44 / other "connect a tool" flows:** same three fields as the table above — server URL, Bearer auth, key.

---

## Local (stdio) setup

Use this when a client can only launch a local process, not call a remote URL.

**1. Get an API key.** Sign in to the dashboard at [app.usemektup.com](https://app.usemektup.com), open **API keys**, and create one. Keys look like `mek_live_...` and are shown exactly once - copy it immediately.

**2. Install dependencies:**
```bash
git clone https://github.com/WeeCi/mektup-mcp.git
cd mektup-mcp
npm install
```

**3. Configure your MCP client** to run `server.js` with the key as an environment variable. For Claude Desktop / Claude Code, add to your MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mektup": {
      "command": "node",
      "args": ["/absolute/path/to/mektup-mcp/server.js"],
      "env": {
        "MEKTUP_API_KEY": "mek_live_..."
      }
    }
  }
}
```

`MEKTUP_API_BASE_URL` is optional and defaults to `https://api.usemektup.com` — no need to set it under normal use.

The server refuses to start without `MEKTUP_API_KEY` set.

---

## How tools respond

Every tool returns its result as JSON text on success. On failure, it returns `isError: true` with `Error: <message>` — the message is the same one the underlying REST endpoint returned (see the [API reference](https://usemektup.com/docs/api.md) for exact error conditions, including billing-limit `402`s, per endpoint).

---

## Tools

### Account

| Tool | Input | Description |
|---|---|---|
| `get_me` | — | Get the authenticated account identity. Useful as an auth health check. |
| `get_usage` | — | Current billing tier, its limits, and real usage against them. Check before a bulk operation. |

### API keys

| Tool | Input | Description |
|---|---|---|
| `list_api_keys` | — | List keys on this account (prefix and status only). |
| `create_api_key` | — | Create a new key. **The full key is returned exactly once** - surface it to the user immediately so they can save it. |
| `revoke_api_key` | `id` | Revoke a key immediately. Cannot be undone - confirm with the user first, especially if it might be the key this very session is using. |

### Domains

| Tool | Input | Description |
|---|---|---|
| `create_domain` | `domain` | Register a domain, get back the exact DNS records (MX/SPF/DMARC/DKIM) and a setup recommendation. Never touches DNS itself. |
| `list_domains` | — | List every domain on this account. |
| `get_domain_records` | `domain` | Re-fetch a registered domain's DNS records any time after creation. |
| `verify_domain` | `domain` | Actively re-check live DNS and flip verified once it matches. Not automatic. |
| `delete_domain` | `domain` | Delete a domain and everything under it. Destructive — confirm with the user first. |

### Mailboxes

| Tool | Input | Description |
|---|---|---|
| `create_mailbox` | `domain`, `localPart`, `password?` | Create a mailbox with real IMAP/SMTP-AUTH credentials, usable in any mail client. |
| `list_mailboxes` | `domain` | List mailboxes on a domain. |
| `reset_mailbox_password` | `domain`, `localPart`, `password?` | Reset a mailbox's login password. Shown once. |
| `delete_mailbox` | `domain`, `localPart` | Delete a mailbox. Confirm with the user first. |

### Webhooks

| Tool | Input | Description |
|---|---|---|
| `get_mailbox_webhook` | `domain`, `localPart` | Check a mailbox's configured webhook URL (never returns the signing secret). |
| `set_mailbox_webhook` | `domain`, `localPart`, `url`, `regenerateSecret?` | Set/update the URL that fires (HMAC-signed) on every new inbound message - how an agent finds out about new mail without polling `list_messages`. Returns the signing secret once, on first setup or rotation. |
| `delete_mailbox_webhook` | `domain`, `localPart` | Remove a mailbox's webhook. |

### Forwarding

| Tool | Input | Description |
|---|---|---|
| `list_forwards` | `domain`, `localPart` | List addresses that get a copy of incoming mail. |
| `add_forward` | `domain`, `localPart`, `forwardTo` | Add a forwarding address. |
| `remove_forward` | `domain`, `localPart`, `id` | Remove a forwarding address. |

### Identity

| Tool | Input | Description |
|---|---|---|
| `get_identity` | `domain`, `localPart` | Get display name and signature. |
| `set_identity` | `domain`, `localPart`, `displayName?`, `signatureText?`, `signatureHtml?` | Set display name/signature, applied automatically to outgoing mail. |

### Vacation / auto-reply

| Tool | Input | Description |
|---|---|---|
| `get_vacation` | `domain`, `localPart` | Get vacation auto-reply settings. |
| `set_vacation` | `domain`, `localPart`, `enabled`, `subject?`, `message?` | Enable/configure auto-reply. `message` required when enabling. |

### Folders

| Tool | Input | Description |
|---|---|---|
| `list_folders` | `domain`, `localPart` | List custom folders. |
| `create_folder` | `domain`, `localPart`, `name` | Create a folder. |
| `delete_folder` | `domain`, `localPart`, `id` | Delete a folder (mail in it falls back to Inbox/Sent). |

### Contacts

Account-level, not per-mailbox.

| Tool | Input | Description |
|---|---|---|
| `list_contacts` | — | List contacts. |
| `create_contact` | `name?`, `email` | Add a contact. |
| `update_contact` | `id`, `name?`, `email?` | Partially update — only send fields to change. |
| `delete_contact` | `id` | Delete a contact. |

### Drafts

| Tool | Input | Description |
|---|---|---|
| `list_drafts` | `domain`, `localPart` | List drafts (metadata only). |
| `get_draft` | `domain`, `localPart`, `id` | Get a draft including its body. |
| `create_draft` | `domain`, `localPart`, `to?`, `subject?`, `text?`, `html?` | Create a draft. |
| `update_draft` | `domain`, `localPart`, `id`, `to?`, `subject?`, `text?`, `html?` | Partial update (autosave-friendly). |
| `delete_draft` | `domain`, `localPart`, `id` | Delete a draft. |

### Sending

| Tool | Input | Description |
|---|---|---|
| `send_email` | `from`, `to`, `subject`, `text?`, `html?`, `attachments?`, `draftId?` | Send real mail. `from` must be a mailbox on this account, or any address on a domain this account has verified. Attachments are `{filename, contentType?, contentBase64}`, max 10MB decoded each. Pass `draftId` to delete a draft on successful send. |

**Example:**
```
send_email({ from: "hello@example.com", to: "you@gmail.com", subject: "It works", text: "Real mail, sent through Mektup." })
→ { "messageId": "<...@example.com>", "envelope": { "from": "hello@example.com", "to": ["you@gmail.com"] } }
```

### Messages & threads

| Tool | Input | Description |
|---|---|---|
| `list_messages` | `mailbox`, `limit?`, `direction?`, `trash?`, `folder?`, `q?` | List messages (one row per thread). Pass `direction` to split Inbox/Sent — omitting it merges both. |
| `get_delivery_stats` | `mailbox`, `days?` | Aggregate sent/deferred/bounced/unknown counts for a mailbox's outbound mail, sourced from Mektup's own Postfix delivery log — not a tracking pixel. |
| `get_thread` | `threadKey`, `mailbox`, `direction?`, `trash?`, `folder?` | Every message in one thread, oldest first. |
| `get_message` | `id` | Full message content. Marks it read as a side effect. **`html` is attacker-controlled** — never render it directly. |
| `update_message` | `id`, `read?`, `restore?`, `flagged?`, `folderId?` | Mark read/unread, restore from trash, flag, or move to a folder — any combination in one call. |
| `delete_message` | `id` | Two-stage delete: first call trashes, second call on an already-trashed message permanently deletes it. Confirm before a permanent delete. |
| `download_attachment` | `id`, `index` | Download one attachment, base64-encoded. Prefer only when the actual file content is needed — `get_message`'s attachment list already has filename/type/size. |

### Account-wide

| Tool | Input | Description |
|---|---|---|
| `get_unread_counts` | — | Unread Inbox count for every domain/mailbox at once. |

---

## See also

- [Full REST API reference](https://usemektup.com/docs/api.md) — everything this server wraps
- [OpenAPI 3.1 spec](https://usemektup.com/docs/openapi.yaml) — machine-readable version of the same API
- [usemektup.com](https://usemektup.com) — sign up, dashboard, pricing

## License

MIT
