# Using the CXCaller MCP server

How to let an AI agent place phone calls and run calling campaigns for you, from
first connection to reading the results. For every tool and its parameters, see
the [tool reference](./tool-reference.md). To host the server yourself, see the
[README](../README.md).

- [What you can do](#what-you-can-do)
- [Get set up](#get-set-up)
- [How it works](#how-it-works)
- [Recipes](#recipes)
- [Writing good instructions](#writing-good-instructions)
- [Reading results](#reading-results)
- [Safety and limits](#safety-and-limits)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

## What you can do

Connect an AI agent (Claude, Cursor, or anything that speaks MCP) and ask it, in
plain language, to:

- **Call one person**: "Call +94 77 123 4567 and ask whether their parcel
  arrived", then get the summary, the answers and the full transcript.
- **Run a campaign**: build it, review it, launch it to a list, watch progress,
  pause it, and read what everyone said.
- **Collect structured answers**: "Did they agree to pay? On what date?" come back
  as yes/no and dates you can count, not just a transcript.
- **Manage contacts and groups**, and stop calling someone.
- **Report**: answer rates, call volume, how calls ended.

Everything the agent does uses the normal platform, so campaigns, contacts and
call transcripts also appear in the CXCaller dashboard.

## Get set up

### 1. Create an API key

A key belongs to one organization and lets a program act for it. It is created by
an **owner or admin** of the organization, and it is **shown once**.

Use the **API keys** page in the dashboard, or the API:

```bash
curl -X POST https://api.cxcaller.com/organizations/$ORG_ID/api-keys \
  -H "Authorization: Bearer $YOUR_LOGIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"support-agent"}'
# → { "key": "cxk_…", "prefix": "cxk_a1b2c3d4", … }   copy "key" now
```

Treat it like a password. Give **each agent or integration its own key**, named
for what it is, so you can revoke one without breaking the others.

### 2. Connect your agent

The server lives at **`https://mcp.cxcaller.com/mcp`** and authenticates with
`Authorization: Bearer cxk_…` (or `X-API-Key: cxk_…`).

**Claude Code**

```bash
claude mcp add --transport http cxcaller https://mcp.cxcaller.com/mcp \
  --header "Authorization: Bearer cxk_…"
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "cxcaller": {
      "url": "https://mcp.cxcaller.com/mcp",
      "headers": { "Authorization": "Bearer cxk_…" }
    }
  }
}
```

**Claude Desktop** launches local commands, so reach the remote server through the
`mcp-remote` adapter (`claude_desktop_config.json`, then fully quit and reopen):

```json
{
  "mcpServers": {
    "cxcaller": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.cxcaller.com/mcp",
               "--header", "Authorization:${CXCALLER_AUTH}"],
      "env": { "CXCALLER_AUTH": "Bearer cxk_…" }
    }
  }
}
```

**Your own code** can use any MCP SDK's Streamable HTTP client with that URL and
header. **Clients that can only sign in with OAuth can't connect**, because the
server uses API keys rather than OAuth; use one that lets you set a header, or the
adapter above.

**Prefer to run it locally?** The server also runs over stdio with the key in an
environment variable (`CXCALLER_API_KEY`); see the [README](../README.md).

### 3. Check it works

Ask the agent: *"Use CXCaller to show me which account I'm connected to."* It
calls `get_account` and should return your organization's name. If it doesn't,
see [Troubleshooting](#troubleshooting).

No agent handy? This lists the tools straight from the server:

```bash
curl -X POST https://mcp.cxcaller.com/mcp \
  -H "Authorization: Bearer cxk_…" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## How it works

Three ideas explain almost everything the agent does.

**1. Calls are made by campaigns.** The platform dials through campaigns, so
`make_call` is a convenience: it creates and launches a campaign with a single
person in it. That is why a one-off call shows up in the dashboard's campaign list
as `Call to <name or number> · <date time>`.

**2. Dialing isn't instant.** A launched campaign is picked up on a roughly
**20-second cycle**. A call begins within about 20 seconds of being placed, and
then lasts anywhere from ~30 seconds to a few minutes. So the normal pattern is
*place the call, then check back*:

```
make_call  ──▶  { campaign_id, finished: false }
   …wait…
get_call_result(campaign_id)  ──▶  { finished: true, calls: [ summary, transcript, … ] }
```

`make_call` can also wait for you: pass `wait_seconds` (up to **80**) and it holds
the request open and returns the finished result if the call ends in time. If it
doesn't, it returns what it has, and you poll `get_call_result` as above.

**3. Campaigns follow a lifecycle.**

```
draft ──launch──▶ scheduled ──(≈20 s)──▶ running ──▶ completed
  ▲                   │                    │  ▲
  │                   │                 pause  resume
  │                   ▼                    ▼  │
  └──reactivate── cancelled ◀──cancel────── paused
```

- **Launch needs an approved content review.** The platform checks every
  campaign's instructions, objective and per-person prompt overrides against its
  community guidelines before it may launch. `launch_campaign` (and `make_call`)
  submit the campaign and wait for the verdict, which usually takes under a minute.
  One the review won't pass automatically is **flagged** for a CXCaller admin and
  can't launch until they approve it; one an admin **rejects** needs new content.
  Nothing is dialed in either case. To learn the verdict before you commit, ask
  for `verify_campaign` on the draft.
- Changing the instructions or objective **voids the approval**: the campaign
  is reviewed again at the next launch, and a `scheduled` one goes back to `draft`.
- A campaign is **editable only as a `draft` or `scheduled`**. Once running,
  paused or finished it is locked; to change one, cancel it, then reactivate it
  back to a draft.
- **`create_campaign` makes a draft by default.** Nothing is dialed until it is
  launched, so you can review it first.
- A campaign completes on its own once every recipient has finished (answered,
  no answer, failed, out of attempts, or skipped).

## Recipes

Each shows a request you might type, and what the agent does with the tools.

### Call one person

> "Call Nimal on +94771234567 and ask whether the parcel with order A-1 arrived.
> Speak English. Keep it under two minutes."

The agent calls `make_call` with `to`, `name`, and `instructions` (the voice
agent's brief), then `get_call_result` until `finished` is `true`. Ask for the
outcome: *"How did it go?"* → the summary, whether they answered, and the
transcript.

Add `wait_seconds: 60` (or say "wait for the result") to get the answer in one go.

### Get structured answers back

Free text is hard to count. Tell the agent **what you want to know**:

> "Call these three customers about their overdue invoices. For each one I need:
> did they agree to pay (yes/no), the date they promised, and a reference number
> if they gave one."

The agent declares **outcome fields** (`paid` boolean, `promised_date` text,
`reference_no` text) on the campaign *before* dialing. Afterwards
`get_campaign_outcomes` returns tallies (12 yes, 4 no) and, with per-person detail,
who said what. Two rules:

- Declare them **before calls run**. They can't be added to calls that already
  happened.
- A question the person never answered comes back as `null`, not a guess.

### Run a campaign to a list

> "Create a campaign called 'September reminders' that calls everyone in the
> 'Overdue' group. The agent should be polite, mention their `amount`, and offer a
> callback to +94112345678. Weekdays 9:00 to 17:00 Colombo time, up to 5 calls at
> once, retry no-answers once. Show it to me before you launch."

The agent calls `create_campaign` with the agent settings, schedule and the group,
and stops at the draft. You review it with `get_campaign`, and `verify_campaign`
tells you whether the platform's content review passes it. Then:

> "Looks good. Launch it."

→ `launch_campaign`. Things worth saying explicitly, because the defaults are
cautious:

| You want | Say / it sets | Default |
| --- | --- | --- |
| Several people called at once | `max_concurrent_calls` | **1** (one person at a time) |
| Redial no-answers | `max_attempts` (and `retry_delay_minutes`) | **1** (no redials) |
| Only call in business hours | `calling_window_start` / `_end`, `timezone`, `calling_days` | any time |
| Start later | `scheduled_start_at` | as soon as launched |

A calling window that is closed doesn't cost a recipient an attempt: the call is
simply deferred to the next open moment.

### Watch and control it

> "How is the September campaign going?" → `get_campaign_stats`
> "Pause it." → `control_campaign` with `pause`
> "Resume." / "Cancel it." → `control_campaign` with `resume` / `cancel`

Stats refresh about every 5 seconds while running (don't poll faster) and report
recipients done, calls made, connect rate, minutes, cost, and how calls ended.
`pause` stops new calls from being dialed (the dialer checks before each one) and
doesn't cut off a call already in progress. A closed calling window or a pause never
costs a recipient one of its attempts.

### Read what happened

| Ask | Tool |
| --- | --- |
| "Who answered, who didn't?" | `list_campaign_recipients` (use `group: needs_attention` for no-answer/failed) |
| "Show me the calls" | `list_campaign_calls` |
| "What did they say?" | `get_call` (summary, key points, action items, full transcript) |
| "Give me a link to the recording" | `get_call_recording_url` (expires quickly) |
| "How many agreed to pay?" | `get_campaign_outcomes` |

### Retry the ones that failed

> "Try the people who didn't answer again."

The agent finds them with `list_campaign_recipients` (`group: needs_attention`) and
`retry_campaign_recipient` for each. Two things to know:

- Only recipients that are `no_answer`, `failed` or `exhausted` can be retried.
- **Retry only works while the campaign is still running.** The platform never dials
  a `completed`, `cancelled` or `failed` campaign again, and a campaign completes as
  soon as everyone has finished. So "retry the ones who didn't answer" after a
  campaign has ended is refused with an explanation: the agent should instead
  **create a new campaign** for those people. On a *paused* campaign the retry is
  queued and waits for resume.

### Manage contacts

> "Add Kamal Silva, +94771000002, as a contact and put him in the Overdue group."
> "Stop calling +94771000002."

→ `create_contact` / `create_contact_group` / `add_contacts_to_group`, and
`update_contact` with status `blocked`. **Prefer blocking over deleting**: the
dialer skips any contact that isn't `active` at the moment it would dial, **even one
already on a running campaign**, and the contact keeps its history. `delete_contacts`
is permanent. A phone number can exist only once per organization, so the agent
searches with `list_contacts` before creating.

### Report

> "How did calls go this month compared to last month?" → `get_analytics_overview`
> "Break down last week by day." → `get_analytics_report`

Both take a `period` (`day`, `week`, `month`, `quarter`, `year`) and compare it to
the equal-length period before it.

## Writing good instructions

The `instructions` field is the voice agent's whole brief. What goes in it decides
how the call sounds.

**Do**

- Say **who the agent is and who it's calling**: "You are Maya from IIT Payments,
  calling {{contact_name}}."
- State **one clear purpose** and **what a good ending looks like**: "Confirm the
  payment date, then thank them and end the call."
- Say **what to find out**, in the order you want it.
- Tell it what to do when things go sideways: wrong person, "not now", asks to
  stop, asks for a human ("offer to transfer" and set `transfer_to`).
- Set `language` (`"si"`, `"si-LK"` and `"Sinhala"` all work) and pick a voice with
  `list_voices` → `voice_id`.

**Personalize with variables**

Give each person their own facts and reference them as `{{name}}`:

```
instructions: "…remind {{contact_name}} that {{payment_amount}} was due on {{due_date}}…"
recipients:   [{ "phone": "+94771000002", "name": "Kamal",
                 "variables": { "payment_amount": "20000", "due_date": "21 May" } }]
```

- **Every `{{placeholder}}` must exist for every recipient.** A call whose brief
  references a missing variable **fails before dialing**, and the person is marked
  `failed` with a template error. Either supply the value for everyone or leave the
  placeholder out.
- `shared_variables` gives every recipient the same value (`{"company":"IIT"}`);
  a person's own variables win over shared ones.
- Values you *don't* put in a placeholder are still shown to the agent as background
  context, so a placeholder isn't required for it to know a fact.

**Keep it short.** A page of rules is worse than a paragraph and a few clear
priorities. Test with one call to yourself (`make_call`) before launching to a list.

**Be responsible.** Calls reach real people. Only call people you have a legitimate
reason and the consent to call, respect local rules on calling hours and disclosure,
and honor requests to stop (block the contact). You are responsible for your
calling; the agent will place whatever calls you ask it to.

## Reading results

### How a call ended

| `outcome` | Meaning |
| --- | --- |
| `completed` | Someone answered and the conversation finished |
| `declined` | The person rejected the call |
| `no_answer` | It rang out |
| `busy` | Engaged tone |
| `voicemail` | Reached voicemail |
| `failed` | The call couldn't be completed (for example a provider error) |

A call's **status** moves `queued → dialing → ringing → answered → completed`.
Voicemail and warm transfers both finish as `completed`; tell them apart by
`outcome` and the `transferred` flag, not by status.

### Where each person stands

`queued`, `scheduled` (waiting) · `dialing`, `in_progress` (on a call now) ·
`completed` · `no_answer`, `failed`, `exhausted` (needs attention) · `suppressed`,
`cancelled` (skipped). **`exhausted`** means the outcome was retryable but the
attempts ran out: the fix is to raise `max_attempts` and retry, not to debug an
error.

### A call result, abridged

```jsonc
{
  "finished": true,
  "campaign": { "id": "…", "status": "completed" },
  "calls": [{
    "id": "CALL-20260920-a1b2c3d4e5f60718",
    "status": "completed", "outcome": "completed",
    "durationSeconds": "73", "sentiment": "positive",
    "summary": "Nimal confirmed the parcel arrived on Tuesday.",
    "keyPoints": ["Parcel arrived Tuesday", "No damage"],
    "extractedData": { "arrived": true },
    "transcript": [{ "role": "agent", "text": "Hello, is that Nimal?" }, …]
  }]
}
```

`finished` is `true` once the campaign has reached `completed`, `cancelled` or
`failed`. For a single call, that means the call is over.

## Safety and limits

The server is built so an agent can't easily do something you didn't intend.

- **Drafts first.** `create_campaign` doesn't dial. Launching is a separate,
  explicit step (`launch_campaign`, or `launch: true`).
- **Content review.** The platform dials only campaigns whose content its review
  has approved. Flagged content waits for a CXCaller admin; nothing is dialed
  meanwhile.
- **Launch size cap.** A campaign with more than **1,000 recipients** is refused at
  launch, however the recipients were added. Nothing is dialed. (Ask the operator
  if you need it raised.)
- **Your key's reach.** A key acts as a *member* of one organization. It can't manage
  people or billing, create or revoke keys, or claim phone numbers.
- **Rate limits.** Each organization gets about **300 requests per minute** and **8
  in flight at once**; beyond that the server answers `429` with a `Retry-After`. A
  well-behaved agent never notices. Repeatedly presenting invalid keys temporarily
  blocks that address.
- **No blind retries.** A failed write is never repeated automatically, so a network
  blip can't place a second call. Reads are retried.
- **Your data.** The server keeps nothing: it forwards your key to the platform for
  each request. Logs record which tool ran and for which organization, never keys,
  arguments or call content.

**Good practice:** one key per agent; name keys for what they do; revoke any you
no longer use (revocation takes effect on the next action); ask the agent to *show
you a draft* before launching anything large; and start with one test call.

## Troubleshooting

| You see | Likely cause | Fix |
| --- | --- | --- |
| `401` / "rejected the API key" | Key is wrong, revoked, or from another environment | Create a fresh key and check it starts with `cxk_` |
| "Missing API key" | The client isn't sending the header | Check the `Authorization: Bearer …` header is configured |
| Agent lists no CXCaller tools | Config not loaded | Restart the client (Claude Desktop: fully quit) and check the JSON |
| `403` "Forbidden host" | Wrong URL or a proxy rewriting `Host` | Use exactly `https://mcp.cxcaller.com/mcp` |
| `403` "API keys cannot use this endpoint" | The action is off-limits to keys by design | Do it in the dashboard (managing members, keys, numbers) |
| `error.campaign_incomplete` with `missing: […]` | Launch needs `recipients`, `caller_id`, or `agent` (instructions) | Fix what's listed, then launch again |
| "Not launched: content verification is "flagged"" | The platform's content review held the campaign for a CXCaller admin | Wait for an admin to approve it (check `reviewStatus` with `get_campaign`), or rewrite the instructions and launch again |
| "Not launched: content verification is "rejected"" | An admin rejected the content | Change the instructions or objective with `update_campaign`, then launch again |
| "Not launched: content verification is "pending"" | The review hasn't answered yet | Call `launch_campaign` again in a minute; it continues the same review |
| "Use E.164 format" | Phone number isn't `+<country code><number>` | Use `+94771234567`: no spaces, dashes or leading `0` |
| "Failed at '…'" and a campaign id | A multi-step tool stopped partway | The draft **exists and nothing was dialed**. Fix the problem and continue with `update_campaign` / `add_campaign_recipients` / `launch_campaign`, or `delete_campaign` |
| `error.campaign_not_editable` | Campaign is running, paused or finished | `control_campaign` `cancel`, then `reactivate`, then edit |
| "…is completed, and the platform never dials a completed campaign again" | Tried to retry a recipient on a finished campaign | Create a new campaign for those people |
| "Only recipients that are no_answer, failed or exhausted can be retried" | The recipient is in another state | Check its status with `list_campaign_recipients` |
| Call never starts | Campaign still `scheduled` (≤ ~20 s), paused, outside its calling window, or waiting behind `max_concurrent_calls: 1` | Check `get_campaign` status and `get_campaign_stats`; raise concurrency |
| Recipient `failed` before dialing | A `{{placeholder}}` has no value for that person | Supply the variable for everyone, or remove the placeholder |
| `finished: false` for a long time | Call still in progress, or waiting in the queue | Poll every ~5 s; check the campaign status |
| `429` "Rate limit" | Too many requests for the organization | Wait for `Retry-After` seconds |
| "Refusing to launch: … above this server's limit" | Campaign exceeds the recipient cap | Split it into smaller campaigns |
| `500` on adding recipients via `recipients` (phone numbers) | A known platform-side fault in `/contacts/import` | Handled automatically: on a `5xx` the tool falls back to finding-or-creating each contact and attaching by id. If that fallback also fails, contact support with the `X-Request-Id` from the response |
| Duplicate contact (`409`) | That number already exists | Find it with `list_contacts` instead of creating it |

For any server-side problem, quote the **`X-Request-Id`** response header when
contacting support. It identifies the exact request.

## FAQ

**Does the agent hold a real conversation?** Yes: calls are handled by a live
voice AI following your `instructions`, in the language and voice you choose. It
isn't a recording or a fixed script.

**Can I hear or read the call afterwards?** Yes: `get_call` gives the summary,
key points and full transcript, and `get_call_recording_url` gives a short-lived
link to the audio.

**Can the agent hand a call to a person?** If you set `transfer_to` (an E.164
number) and tell the agent when to use it, it can warm-transfer the caller.

**Which number do calls come from?** By default a number from the shared pool that
the dialer picks per call. To always use one of your own claimed numbers, set
`caller_id` to `dedicated` with a number from `list_caller_ids`. (Claiming numbers
is done in the dashboard, not through the agent.)

**What does it cost?** Calls are billed to your organization; `get_campaign_stats`
reports minutes and cost so far. Pricing itself is on your plan, not in the tool.

**Is it safe to give an agent a key?** It can place real calls and delete contacts
within your organization, so treat it like a password: one key per agent, revoke
when finished, and keep agents you don't fully trust supervised (ask them to show
drafts before launching). It can't touch billing, members or keys.

**Can I make it read-only?** The hosted server always has every tool. If you run
your own copy (see the [README](../README.md)), `CXCALLER_MCP_READ_ONLY=true`
removes every tool that places calls or changes data.

**Where are the parameters?** In the [tool reference](./tool-reference.md).
