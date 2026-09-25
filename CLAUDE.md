# CLAUDE.md

MCP server exposing the CXCaller REST API to AI agents. TypeScript, ESM, `@modelcontextprotocol/sdk` + `zod`. Use **pnpm**.

```bash
pnpm test         # unit tests (fake API), no network
pnpm typecheck && pnpm build
pnpm test:e2e     # needs CXCALLER_E2E_URL/EMAIL/PASSWORD and a running cxcaller-api; run `pnpm build` first
```

## Rules

- Relative imports end in `.js` (NodeNext), even for `.ts` sources.
- One tool = one `defineTool({...})` in `src/tools/<toolset>.ts`. Set `mutating` honestly: it drives read-only mode and the `readOnlyHint` annotation. Set `reachesPeople` on anything that can cause a phone to ring, and `destructive` on deletes.
- Tool arguments are `snake_case`; the API's are `camelCase`. Translate in the handler; never leak API field names into tool inputs.
- Never advertise a parameter the API ignores (e.g. `list_contact_groups` takes no paging). An agent will assume it worked.
- Only GETs are retried (`client.ts`). Do not add retries to writes: a repeated POST can place a second call.
- Multi-step tools (`create_campaign`, `make_call`) go through `withProgress` so a mid-way failure names the step and the draft campaign left behind.
- Anything that can dial must pass through `launchWithGuard`, which enforces `CXCALLER_MCP_MAX_RECIPIENTS`.
- Tests assert exact request sequences against `test/helpers.ts`'s fake API. When you add a tool, add its sequence there, and cover the live API in `test/e2e/live.test.ts`; a fake cannot catch validation mismatches.

## Platform facts that shape the tools

- Auth is an API key (`Authorization: Bearer cxk_…` or `X-API-Key`), bound to one organization; `GET /api-key/whoami` yields the org id every path needs.
- The API has no single-call endpoint: `make_call` composes create → configure → import → launch on a one-recipient campaign. The dispatcher ticks every 20 s.
- Launch requires `reviewStatus: approved`. `POST …/verify` submits the content (prompt, objective, recipient `contextOverride`s); an AI reviewer answers in ~15–40 s with `approved` or `flagged` (an admin then approves or `rejected`s). Changing that content resets it to `unverified` and a `scheduled` campaign to `draft`. `launchWithGuard` submits and waits (within `CXCALLER_MCP_MAX_WAIT_SECONDS`), and treats a missing `reviewStatus` as an API that predates verification.
- Campaign config is only editable in `draft`/`scheduled`. `PATCH` replaces `objectiveConfig` wholesale, so `update_campaign` merges onto the existing value first.

## Hosted mode (mcp.cxcaller.com)

- `src/http.ts` serves many tenants from one process. It has **no server-side key**, and must never gain one: a fallback would let anonymous callers act as a tenant. Never log keys, tool arguments, or bodies.
- Limits are per **organization** (not per key) and per pod. Auth happens before the body is read.
- Cloudflare drops a proxied request at 100 s: keep `CXCALLER_MCP_MAX_WAIT_SECONDS` below that, and `terminationGracePeriodSeconds` in the chart >= `preStopSeconds` + `CXCALLER_MCP_SHUTDOWN_GRACE_MS`.
- Deployment lives in `cxcaller-infra` (`charts/cxcaller-mcp`, `argocd/apps/cxcaller-mcp.yaml`, Cloudflare tunnel + DNS in `terraform/`). CI bumps the image tag in that repo on merge to `main`.
