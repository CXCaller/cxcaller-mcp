# CXCaller MCP

An [MCP](https://modelcontextprotocol.io) server that lets AI agents use CXCaller: place a phone call, run a calling campaign, manage contacts, and read back what the calls found out.

It is a thin layer over the CXCaller REST API and authenticates with an **API key** from the platform. It holds no state and no data of its own.

```
AI agent ──MCP──▶ cxcaller-mcp ──HTTPS + API key──▶ CXCaller API ──▶ voice agents ──▶ phone network
```

## Get an API key

Keys belong to one organization and are created by an owner or admin of it (the key is shown **once**):

```bash
curl -X POST https://api.cxcaller.com/organizations/$ORG_ID/api-keys \
  -H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json" \
  -d '{"name":"support-agent"}'
# → { "id": "…", "prefix": "cxk_a1b2c3d4", "key": "cxk_…full secret…" }
```

Revoke with `DELETE /organizations/:id/api-keys/:keyId`. A key acts as an organization **member**: it can use contacts, campaigns, calls, analytics and phone-number browsing, but cannot manage members, invitations, billing, API keys, or claim/release phone numbers. Details in the API repo's `docs/api-keys.md`.

## Connect

**Local (stdio)** — Claude Desktop, Cursor, Claude Code, Windsurf…

```bash
pnpm install && pnpm build      # produces dist/cli.js
```

```json
{
  "mcpServers": {
    "cxcaller": {
      "command": "node",
      "args": ["/absolute/path/to/cxcaller-mcp/dist/cli.js"],
      "env": { "CXCALLER_API_KEY": "cxk_…" }
    }
  }
}
```

Once the package is published, `"command": "npx", "args": ["-y", "@cxcaller/mcp"]` does the same without a checkout.

**Remote (Streamable HTTP)** — host it once, every agent brings its own key:

```bash
cxcaller-mcp --http --port 3333          # POST /mcp, GET /healthz
```

```json
{ "mcpServers": { "cxcaller": { "url": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer cxk_…" } } } }
```

The HTTP server is stateless and binds to `127.0.0.1` by default. Put TLS in front of it before exposing it (`--host 0.0.0.0`); it does not terminate TLS itself.

## What agents can do

| Goal | Tools |
| --- | --- |
| **Call one person** | `make_call` → `get_call_result` |
| **Run a campaign** | `create_campaign` (draft, or `launch: true`) → `launch_campaign` → `get_campaign_stats` → `get_campaign_outcomes` |
| Control a campaign | `control_campaign` (pause / resume / cancel / reactivate), `update_campaign`, `add_campaign_recipients`, `list_campaign_recipients`, `retry_campaign_recipient`, `delete_campaign` |
| Inspect calls | `list_campaign_calls`, `get_call` (transcript), `get_call_recording_url` |
| Contacts | `list_contacts`, `get_contact`, `create_contact`, `create_contacts_bulk`, `update_contact`, `delete_contacts`, `list_contact_groups`, `create_contact_group`, `add_contacts_to_group` |
| Reference | `get_account`, `list_caller_ids`, `list_voices` |
| Reporting | `get_analytics_overview`, `get_analytics_report` |

### How `make_call` works

The platform dials through campaigns, and has no single-call endpoint. `make_call` creates a one-recipient campaign (`max_attempts: 1`, one call at a time), launches it, and returns its `campaign_id`. So:

- dialing begins within **~20 s** (the dispatcher's tick), and a call takes roughly 30 s to a few minutes;
- poll `get_call_result` until `finished` is true, or pass `wait_seconds` (max 110) to wait inside the call;
- each call shows up in the dashboard as a campaign named `Call to <name> · <time>`.

To get structured answers back (e.g. "agreed to a callback?"), declare `outcome_fields` **before** the call runs.

## Safety

Calls reach real people, so the server is conservative by default:

- **`create_campaign` makes a draft.** Nothing dials until `launch_campaign`, or `launch: true`.
- **Launch cap.** `launch_campaign` (and `launch: true`) checks the campaign's *actual* recipient count and refuses above `CXCALLER_MCP_MAX_RECIPIENTS` (default 1000), however the recipients got there.
- **Read-only mode.** `CXCALLER_MCP_READ_ONLY=true` removes every tool that places calls or changes data; agents cannot even see them.
- **Toolsets.** `CXCALLER_MCP_TOOLSETS=calls,campaigns` exposes only what an agent needs.
- **Tool annotations.** Every tool declares read-only / destructive / reaches-people hints so clients can require approval for the dangerous ones.
- **No blind retries.** Only GETs are retried; a failed POST is never repeated, so a network blip cannot place a second call.
- **Server-side scoping.** A key is bound to one organization by the API, not by this server, so a compromised MCP host cannot reach another organization.

Consider giving each agent its own key so it can be revoked on its own, and running unattended agents in read-only mode plus a narrow toolset.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `CXCALLER_API_KEY` | – | Required for stdio; fallback in HTTP mode |
| `CXCALLER_API_URL` | `https://api.cxcaller.com` | Dev: `https://dev.api.cxcaller.com` |
| `CXCALLER_MCP_READ_ONLY` | `false` | |
| `CXCALLER_MCP_TOOLSETS` | all | `account,contacts,campaigns,calls,analytics` |
| `CXCALLER_MCP_MAX_RECIPIENTS` | `1000` | Also caps every list an agent may send |
| `CXCALLER_MCP_TIMEOUT_MS` | `30000` | |

## Development

```bash
pnpm install
pnpm test            # unit tests: fake API, MCP client over in-memory + real HTTP
pnpm typecheck && pnpm build
pnpm inspect         # open it in the MCP Inspector

# live tests: drives the built server over stdio against a real API,
# creating its own organization and key
CXCALLER_E2E_URL=http://localhost:3000 CXCALLER_E2E_EMAIL=… CXCALLER_E2E_PASSWORD=… pnpm test:e2e
```

Layout: `src/client.ts` (API client, errors, retries) · `src/tools/*.ts` (one file per toolset; `define.ts` holds registration and read-only/toolset filtering) · `src/server.ts` · `src/stdio.ts` · `src/http.ts` · `src/cli.ts`.

## Known limits

- Revoking a key takes effect on the next tool call. A revoked key can still list tools for up to 5 minutes (cached identity), but nothing else.
- There is no single-call API yet, hence the ~20 s start latency of `make_call`. A dedicated `POST /organizations/:id/calls` would remove it.
- Recipients' `variables` referenced as `{{placeholders}}` must exist on **every** recipient, or that call fails before dialing (platform behaviour).
