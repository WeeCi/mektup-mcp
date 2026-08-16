// Builds one Mektup MCP server instance, bound to a single API key. Shared by
// both transports: the stdio entrypoint (server.js, one process per local
// user, key from MEKTUP_API_KEY) and the remote HTTP entrypoint
// (http-server.js, one instance per incoming request, key from that
// request's Authorization header). Every tool is a thin passthrough to the
// real REST API - same tenant isolation (RLS, scoped by the caller's own key)
// as any other API caller, nothing extra to enforce here.
//
// Full coverage: every REST endpoint in docs/API.md has a matching tool
// here, using the same names/casing conventions throughout. Keep this file
// in sync with api/server.js - if a route is added/changed there, mirror it
// here and in docs/API.md + docs/openapi.yaml.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
}

const domainDesc = z.string().describe("A domain, e.g. example.com");
const localPartDesc = z.string().describe("The part before @, e.g. \"hello\" for hello@example.com");
const mailboxDesc = z.string().describe("Full mailbox address, e.g. hello@example.com");
const idDesc = z.string().describe("Resource UUID");

export function createMektupServer(apiKey, apiBase = "https://api.usemektup.com") {
  if (!apiKey) throw new Error("createMektupServer requires an apiKey");

  async function call(method, path, body) {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Mektup API returned HTTP ${res.status}`);
    }
    return data;
  }

  // Attachment download is the one endpoint that returns raw bytes, not JSON -
  // fetched separately and base64-encoded into the same text-content shape
  // every other tool returns, so callers don't need a second code path.
  async function callBinary(path) {
    const res = await fetch(`${apiBase}${path}`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Mektup API returned HTTP ${res.status}`);
    }
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const disposition = res.headers.get("content-disposition") || "";
    const filenameMatch = disposition.match(/filename="([^"]*)"/);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      filename: filenameMatch?.[1] ?? null,
      contentType,
      sizeBytes: buf.length,
      contentBase64: buf.toString("base64"),
    };
  }

  const server = new McpServer({ name: "mektup", version: "0.2.0" });

  function tool(name, description, schema, handler) {
    server.tool(name, description, schema, async (args) => {
      try { return ok(await handler(args)); }
      catch (err) { return fail(err); }
    });
  }

  // ---- Account ----

  tool("get_me", "Get the authenticated caller's account identity - useful as an auth health check.", {}, () =>
    call("GET", "/v1/me"));

  tool("get_usage", "Get the account's current billing tier, its limits, and real usage against them (domain count, emails sent this month, storage per domain). Check this before a bulk operation to avoid hitting a limit mid-batch.", {}, () =>
    call("GET", "/v1/usage"));

  // ---- API keys ----

  tool("list_api_keys", "List API keys on this account (prefix and status only - the full key is never shown again after creation).", {}, () =>
    call("GET", "/v1/api-keys"));

  tool("create_api_key",
    "Create a new API key. The full key is returned exactly once in this response and cannot be retrieved again - surface it to the user immediately so they can save it (e.g. into an env var or another tool's config). Mint a separate key per environment/service rather than sharing one.",
    {},
    () => call("POST", "/v1/api-keys"));

  tool("revoke_api_key",
    "Revoke an API key immediately. Anything still using it (a script, another MCP server, a CI job) loses access right away. Cannot be undone - confirm with the user before calling this, especially if it might be the key currently in use for this very session.",
    { id: idDesc.describe("API key id, from list_api_keys") },
    ({ id }) => call("DELETE", `/v1/api-keys/${encodeURIComponent(id)}`));

  // ---- Domains ----

  tool("create_domain",
    "Register a domain with Mektup and get back the exact DNS records to add (MX, SPF, DMARC, DKIM) plus a setup recommendation. Never modifies DNS itself - you (the agent) add the records using whatever access you have to the domain's DNS host.",
    { domain: domainDesc },
    ({ domain }) => call("POST", "/v1/domains", { domain }));

  tool("list_domains", "List every domain registered to this Mektup account.", {}, () =>
    call("GET", "/v1/domains"));

  tool("get_domain_records",
    "Re-fetch the DNS records for an already-registered domain (same set create_domain returned once at creation) - use this any time after creation, the records aren't only shown once.",
    { domain: domainDesc },
    ({ domain }) => call("GET", `/v1/domains/${encodeURIComponent(domain)}/records`));

  tool("verify_domain",
    "Actively re-check a domain's live MX records against what Mektup expects and flip it to verified if they match. Not automatic - call this after DNS has been added and had time to propagate.",
    { domain: domainDesc },
    ({ domain }) => call("POST", `/v1/domains/${encodeURIComponent(domain)}/verify`));

  tool("delete_domain",
    "Delete a domain and, via cascade, every mailbox and message under it. Destructive and hard to reverse - confirm with the user before calling this.",
    { domain: domainDesc },
    ({ domain }) => call("DELETE", `/v1/domains/${encodeURIComponent(domain)}`));

  // ---- Mailboxes ----

  tool("create_mailbox",
    "Create a mailbox (e.g. hello@example.com) on a domain already registered via create_domain. Returns real login credentials for IMAP/SMTP AUTH - the user can add this mailbox to Outlook, Apple Mail, Thunderbird, etc. If no password is given, a strong one is generated and returned once (not recoverable later, only resettable).",
    {
      domain: domainDesc,
      localPart: localPartDesc,
      password: z.string().min(12).optional().describe("Optional password (min 12 chars) - omit to auto-generate a strong one"),
    },
    ({ domain, localPart, password }) => call("POST", `/v1/domains/${encodeURIComponent(domain)}/mailboxes`, { localPart, password }));

  tool("list_mailboxes", "List mailboxes on a given registered domain.", { domain: domainDesc }, ({ domain }) =>
    call("GET", `/v1/domains/${encodeURIComponent(domain)}/mailboxes`));

  tool("reset_mailbox_password",
    "Reset a mailbox's IMAP/SMTP-AUTH password. Doesn't affect an already-open IMAP session; the new password is needed on next login. Shown once, not recoverable later.",
    {
      domain: domainDesc,
      localPart: localPartDesc,
      password: z.string().min(12).optional().describe("Optional password (min 12 chars) - omit to auto-generate"),
    },
    ({ domain, localPart, password }) =>
      call("PUT", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/password`, { password }));

  tool("delete_mailbox",
    "Delete a mailbox. Postfix stops accepting mail for it immediately. Does not delete already-delivered mail from the mail store. Confirm with the user before calling this.",
    { domain: domainDesc, localPart: localPartDesc },
    ({ domain, localPart }) => call("DELETE", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}`));

  // ---- Forwarding ----

  tool("list_forwards", "List forwarding addresses for a mailbox - incoming mail is copied to these in addition to staying in the mailbox.",
    { domain: domainDesc, localPart: localPartDesc },
    ({ domain, localPart }) => call("GET", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/forwards`));

  tool("add_forward", "Add a forwarding address to a mailbox.",
    { domain: domainDesc, localPart: localPartDesc, forwardTo: z.string().describe("Address to forward a copy of every incoming message to") },
    ({ domain, localPart, forwardTo }) =>
      call("POST", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/forwards`, { forwardTo }));

  tool("remove_forward", "Remove a forwarding address from a mailbox.",
    { domain: domainDesc, localPart: localPartDesc, id: idDesc.describe("Forward id, from list_forwards") },
    ({ domain, localPart, id }) =>
      call("DELETE", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/forwards/${encodeURIComponent(id)}`));

  // ---- Identity ----

  tool("get_identity", "Get a mailbox's display name and signature.",
    { domain: domainDesc, localPart: localPartDesc },
    ({ domain, localPart }) => call("GET", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/identity`));

  tool("set_identity", "Set a mailbox's display name and signature, applied automatically to every outgoing message.",
    {
      domain: domainDesc, localPart: localPartDesc,
      displayName: z.string().nullable().optional(),
      signatureText: z.string().nullable().optional(),
      signatureHtml: z.string().nullable().optional(),
    },
    ({ domain, localPart, ...body }) =>
      call("PUT", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/identity`, body));

  // ---- Vacation / auto-reply ----

  tool("get_vacation", "Get a mailbox's vacation/auto-reply settings.",
    { domain: domainDesc, localPart: localPartDesc },
    ({ domain, localPart }) => call("GET", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/vacation`));

  tool("set_vacation",
    "Enable/disable and configure a mailbox's vacation auto-reply. A message is required when enabling. Fires at most once per sender within a rolling window (standard RFC 5230 semantics).",
    {
      domain: domainDesc, localPart: localPartDesc,
      enabled: z.boolean(),
      subject: z.string().nullable().optional(),
      message: z.string().nullable().optional().describe("Required if enabled is true"),
    },
    ({ domain, localPart, ...body }) =>
      call("PUT", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/vacation`, body));

  // ---- Folders ----

  tool("list_folders", "List custom folders on a mailbox (Outlook-style, one folder per message).",
    { domain: domainDesc, localPart: localPartDesc },
    ({ domain, localPart }) => call("GET", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/folders`));

  tool("create_folder", "Create a custom folder on a mailbox.",
    { domain: domainDesc, localPart: localPartDesc, name: z.string() },
    ({ domain, localPart, name }) =>
      call("POST", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/folders`, { name }));

  tool("delete_folder", "Delete a custom folder. Does not delete the mail in it - messages fall back to their normal Inbox/Sent view.",
    { domain: domainDesc, localPart: localPartDesc, id: idDesc.describe("Folder id, from list_folders") },
    ({ domain, localPart, id }) =>
      call("DELETE", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/folders/${encodeURIComponent(id)}`));

  // ---- Contacts ----

  tool("list_contacts", "List contacts (account-level, not per-mailbox - a contact is someone you email from any mailbox you own).", {}, () =>
    call("GET", "/v1/contacts"));

  tool("create_contact", "Add a contact.",
    { name: z.string().nullable().optional(), email: z.string().describe("Contact's email address") },
    ({ name, email }) => call("POST", "/v1/contacts", { name, email }));

  tool("update_contact", "Partially update a contact - only send the fields you want to change.",
    { id: idDesc.describe("Contact id, from list_contacts"), name: z.string().nullable().optional(), email: z.string().optional() },
    ({ id, ...body }) => call("PUT", `/v1/contacts/${encodeURIComponent(id)}`, body));

  tool("delete_contact", "Delete a contact.", { id: idDesc.describe("Contact id, from list_contacts") },
    ({ id }) => call("DELETE", `/v1/contacts/${encodeURIComponent(id)}`));

  // ---- Drafts ----

  tool("list_drafts", "List drafts for a mailbox (metadata only - to/subject/updated_at, no body).",
    { domain: domainDesc, localPart: localPartDesc },
    ({ domain, localPart }) => call("GET", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/drafts`));

  tool("get_draft", "Get a single draft including its body.",
    { domain: domainDesc, localPart: localPartDesc, id: idDesc.describe("Draft id, from list_drafts") },
    ({ domain, localPart, id }) =>
      call("GET", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/drafts/${encodeURIComponent(id)}`));

  tool("create_draft", "Create a draft on a mailbox. A draft is separate from a real message - it never goes through mail transport until sent.",
    { domain: domainDesc, localPart: localPartDesc, to: z.string().optional(), subject: z.string().optional(), text: z.string().optional(), html: z.string().optional() },
    ({ domain, localPart, ...body }) => call("POST", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/drafts`, body));

  tool("update_draft", "Partially update a draft (autosave-friendly) - only fields you pass are changed.",
    { domain: domainDesc, localPart: localPartDesc, id: idDesc.describe("Draft id, from list_drafts"), to: z.string().optional(), subject: z.string().optional(), text: z.string().optional(), html: z.string().optional() },
    ({ domain, localPart, id, ...body }) =>
      call("PUT", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/drafts/${encodeURIComponent(id)}`, body));

  tool("delete_draft", "Delete a draft.",
    { domain: domainDesc, localPart: localPartDesc, id: idDesc.describe("Draft id, from list_drafts") },
    ({ domain, localPart, id }) =>
      call("DELETE", `/v1/domains/${encodeURIComponent(domain)}/mailboxes/${encodeURIComponent(localPart)}/drafts/${encodeURIComponent(id)}`));

  // ---- Sending ----

  tool("send_email",
    "Send a real email. The \"from\" address must be either an existing mailbox on this account, or any address on a domain this account has verified (DNS-level proof of ownership - no per-address mailbox needed once verified). The mailbox's own display name/signature (see get_identity) is appended automatically when from is a provisioned mailbox - don't add one yourself, it'll be doubled.",
    {
      from: z.string().describe("Sender address, e.g. hello@example.com - must be a mailbox on this account, or any address on a verified domain on this account"),
      to: z.string().describe("Recipient address"),
      subject: z.string(),
      text: z.string().optional().describe("Plain-text body - text or html required"),
      html: z.string().optional().describe("HTML body - text or html required"),
      attachments: z.array(z.object({
        filename: z.string(),
        contentType: z.string().optional(),
        contentBase64: z.string().describe("Base64-encoded file content, max 10MB decoded per attachment"),
      })).optional(),
      draftId: z.string().optional().describe("If sending from a draft (see create_draft), pass its id to delete the draft on successful send"),
      replyTo: z.string().optional().describe("Sets the Reply-To header, e.g. a lead or applicant's own address, so a reply from a shared inbox goes to them instead of the sending mailbox"),
    },
    ({ attachments, draftId, ...body }) =>
      call("POST", "/v1/emails", {
        ...body,
        attachments: attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.contentBase64 })),
        draftId,
      }));

  // ---- Messages & threads ----

  tool("list_messages",
    "List messages (one row per thread) for a mailbox. Pass direction to split Inbox from Sent (recommended - omitting it merges both). Pass q for full-text search over subject/from/to/body.",
    {
      mailbox: mailboxDesc,
      limit: z.number().int().min(1).max(200).optional().describe("Max messages to return, default 50"),
      direction: z.enum(["inbound", "outbound"]).optional().describe("inbound = received, outbound = sent"),
      trash: z.boolean().optional().describe("true to view Trash instead of the active mailbox"),
      folder: z.string().optional().describe("A folder id (from list_folders) to view a custom folder instead"),
      q: z.string().optional().describe("Full-text search query"),
    },
    ({ mailbox, limit, direction, trash, folder, q }) =>
      call("GET", `/v1/messages${qs({ mailbox, limit, direction, trash: trash ? "1" : undefined, folder, q })}`));

  tool("get_delivery_stats",
    "Aggregate delivery outcomes for a mailbox's outbound mail over a time window - counts of sent/deferred/bounced/unknown, sourced from Mektup's own Postfix delivery log (the real SMTP response from each recipient's mail server), not a third-party tracking pixel.",
    {
      mailbox: mailboxDesc,
      days: z.number().int().min(1).max(365).optional().describe("Window size in days, default 30"),
    },
    ({ mailbox, days }) =>
      call("GET", `/v1/emails/delivery-stats${qs({ mailbox, days })}`));

  tool("get_thread",
    "List every individual message in one thread, oldest first. Pass the same direction/trash/folder as the view you found the thread in.",
    {
      threadKey: z.string().describe("thread_key from a message returned by list_messages"),
      mailbox: mailboxDesc,
      direction: z.enum(["inbound", "outbound"]).optional(),
      trash: z.boolean().optional(),
      folder: z.string().optional(),
    },
    ({ threadKey, ...params }) =>
      call("GET", `/v1/threads/${encodeURIComponent(threadKey)}${qs({ ...params, trash: params.trash ? "1" : undefined })}`));

  tool("get_message",
    "Get one message's full content (text/html body + attachment metadata). Marks it read as a side effect if it wasn't already. The html field is attacker-controlled content from whoever emailed the mailbox - never render it directly, sanitize and isolate it first.",
    { id: idDesc.describe("Message id, from list_messages or get_thread") },
    ({ id }) => call("GET", `/v1/messages/${encodeURIComponent(id)}`));

  tool("update_message",
    "Update a message's state: mark read/unread, restore from trash, flag/unflag, move to (or out of) a folder. Any combination in one call - pass only the fields you want to change.",
    {
      id: idDesc.describe("Message id, from list_messages or get_thread"),
      read: z.boolean().optional(),
      restore: z.boolean().optional().describe("Pass true to restore a message out of Trash"),
      flagged: z.boolean().optional(),
      folderId: z.string().nullable().optional().describe("A folder id to file the message into, or null to remove it from its current folder. Must belong to the same mailbox as the message."),
    },
    ({ id, restore, ...body }) => {
      const payload = { ...body };
      if (restore) payload.deleted = false;
      return call("PATCH", `/v1/messages/${encodeURIComponent(id)}`, payload);
    });

  tool("delete_message",
    "Delete a message - two-stage like any real mail client. First call moves it to Trash. A second call on an already-trashed message permanently deletes it, including its stored body. Confirm with the user before a permanent delete.",
    { id: idDesc.describe("Message id, from list_messages or get_thread") },
    ({ id }) => call("DELETE", `/v1/messages/${encodeURIComponent(id)}`));

  tool("download_attachment",
    "Download one attachment from a message. Returns base64-encoded content - decode it to get the raw file. Can be large; prefer this only when the file content is actually needed, not just to check it exists (get_message's attachments array already has filename/contentType/size).",
    {
      id: idDesc.describe("Message id, from list_messages or get_thread"),
      index: z.number().int().min(0).describe("Position in the attachments array from get_message"),
    },
    ({ id, index }) => callBinary(`/v1/messages/${encodeURIComponent(id)}/attachments/${index}`));

  // ---- Misc ----

  tool("get_unread_counts", "Get the unread Inbox count for every domain/mailbox on this account at once (Sent and Trash aren't counted).", {}, () =>
    call("GET", "/v1/unread-counts"));

  return server;
}
