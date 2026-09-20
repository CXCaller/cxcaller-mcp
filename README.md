# CXCaller MCP

An [MCP](https://modelcontextprotocol.io) server that lets AI agents use CXCaller: place a phone call, run a calling campaign, manage contacts, and read back what the calls found out.

It is a thin layer over the CXCaller REST API and authenticates with an **API key** from the platform. It holds no state and no data of its own.

**Hosted at `https://mcp.cxcaller.com/mcp`.** Any number of organizations use the same deployment, each with their own key. You can also run it yourself (below).

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

**Hosted (recommended)** — nothing to install; your key is the only credential:

```bash
# Claude Code
claude mcp add --transport http cxcaller https://mcp.cxcaller.com/mcp \
  --header "Authorization: Bearer cxk_…"
```

```json
{ "mcpServers": { "cxcaller": { "url": "https://mcp.cxcaller.com/mcp",
    "headers": { "Authorization": "Bearer cxk_…" } } } }
```

`X-API-Key: cxk_…` works in place of the `Authorization` header. The server sends CORS headers, so browser-based MCP clients can connect too.

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

## Hosting

```bash
cxcaller-mcp --http --port 3333    # POST /mcp · GET /healthz · GET /readyz
```

The HTTP server is **stateless and multi-tenant**: each request carries its caller's own API key, which is checked against the platform and used only for that request. It has no server-side key at all (`CXCALLER_API_KEY` is ignored in HTTP mode, so an unauthenticated caller can never be served as someone else). It binds to `127.0.0.1` by default and does not terminate TLS; put a TLS-terminating proxy in front before exposing it.

### What keeps tenants apart and the service healthy

| Concern | Behaviour |
| --- | --- |
| Isolation | A fresh client per request; the only cached data is key → organization id (stored as a hash). The API itself scopes every key to one organization. |
| Fairness | Limits are **per organization**, not per key, so extra keys buy nothing: 300 requests/min and 8 in flight by default. Excess gets `429` + `Retry-After`. |
| Key guessing | A client address that presents too many rejected keys (30/min) is blocked *before* any upstream lookup, so the server is not a key-guessing oracle. |
| Abuse of unauthenticated callers | Authentication happens before the body is read, so anonymous callers cannot make it buffer requests. |
| Host checks | `CXCALLER_MCP_ALLOWED_HOSTS` restricts which host names are served (health probes exempt). |
| Logs | One JSON line per request: request id, organization, key *prefix*, JSON-RPC method, tool name, status, duration. Never keys, arguments, or bodies (they hold credentials and callers' personal data). |
| Deploys | On SIGTERM it stops taking new work and lets in-flight requests finish (a `make_call` may be mid-wait) before exiting. |

Limits are per pod, so with N replicas a tenant's ceiling is roughly N times the configured value. They exist to stop abuse and runaway agents, not to meter usage.

### Behind Cloudflare

Cloudflare cuts a proxied request at **100 s**, so `make_call`'s `wait_seconds` is capped at 80 (`CXCALLER_MCP_MAX_WAIT_SECONDS`) to leave room for call setup. Set `CXCALLER_MCP_TRUST_PROXY=true` **only** when the origin is reachable exclusively through the proxy (a Cloudflare Tunnel is), so per-address limits use the real client address; on a directly reachable origin it would let callers spoof theirs.

### Deploying `mcp.cxcaller.com`

Deployed like the other services: GitHub Actions builds the image, pushes it to Artifact Registry with workload identity, and bumps the tag in `cxcaller-infra`; ArgoCD syncs the `cxcaller-mcp` chart; a Cloudflare Tunnel route and proxied DNS record expose it. The chart holds no secrets. See the runbook in `cxcaller-infra` (`charts/cxcaller-mcp`).

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
- poll `get_call_result` until `finished` is true, or pass `wait_seconds` (max 80) to wait inside the call;
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
| `CXCALLER_API_KEY` | – | stdio only. Ignored by the HTTP server |
| `CXCALLER_API_URL` | `https://api.cxcaller.com` | Dev: `https://dev.api.cxcaller.com` |
| `CXCALLER_MCP_READ_ONLY` | `false` | |
| `CXCALLER_MCP_TOOLSETS` | all | `account,contacts,campaigns,calls,analytics` |
| `CXCALLER_MCP_MAX_RECIPIENTS` | `1000` | Also caps every list an agent may send |
| `CXCALLER_MCP_TIMEOUT_MS` | `30000` | |
| `CXCALLER_MCP_MAX_WAIT_SECONDS` | `80` | Longest `make_call` may wait for a call to end |
| `CXCALLER_MCP_ALLOWED_HOSTS` | – | HTTP: host names to serve, e.g. `mcp.cxcaller.com` |
| `CXCALLER_MCP_TRUST_PROXY` | `false` | HTTP: take client address from `CF-Connecting-IP` / `X-Forwarded-For` |
| `CXCALLER_MCP_RATE_LIMIT_PER_MINUTE` | `300` | HTTP: per organization, per pod |
| `CXCALLER_MCP_MAX_CONCURRENT` | `8` | HTTP: in-flight requests per organization, per pod |
| `CXCALLER_MCP_FAILED_AUTH_PER_MINUTE` | `30` | HTTP: rejected keys per client address before blocking |
| `CXCALLER_MCP_SHUTDOWN_GRACE_MS` | `100000` | HTTP: how long SIGTERM waits for in-flight requests |

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

Layout: `src/client.ts` (API client, errors, retries) · `src/tools/*.ts` (one file per toolset; `define.ts` holds registration and read-only/toolset filtering) · `src/server.ts` · `src/stdio.ts` · `src/http.ts` (hosted transport) · `src/limits.ts` · `src/log.ts` · `src/cli.ts`. `docker build .` produces the deployable image.

## Known limits

- Revoking a key takes effect on the next tool call. A revoked key can still list tools for up to 5 minutes (cached identity), but nothing else.
- There is no single-call API yet, hence the ~20 s start latency of `make_call`. A dedicated `POST /organizations/:id/calls` would remove it.
- Recipients' `variables` referenced as `{{placeholders}}` must exist on **every** recipient, or that call fails before dialing (platform behaviour).
