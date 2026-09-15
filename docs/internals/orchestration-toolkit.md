# Orchestration toolkit (fork-local)

This is a fork-only feature in `NoahLinckeScout/t3code`. It is not upstream and
is not proposed upstream. Keep it additive so rebases onto `pingdotgg/t3code`
stay trivial.

It gives a thread three things t3code does not otherwise have: it can spawn a
child agent on any configured provider, receive a typed result back, and leave a
durable message for another thread without interrupting it.

## Where it plugs in

t3code already mints a per-thread authenticated MCP endpoint and injects it into
all five provider adapters (`ClaudeAdapter`, `CodexAdapter`, `CursorAdapter`,
`GrokAdapter`, `OpenCodeAdapter`) via `readMcpProviderSession`. Until now it
served exactly one toolkit, `preview`. This adds a second one beside it.

That injection point is why the feature is provider-neutral for free. There is no
per-provider spawn path to maintain and no adapter code in this feature.

Files:

- `apps/server/src/mcp/toolkits/orchestration/` — everything new.
- `apps/server/src/mcp/McpHttpServer.ts` — imports and merges the registration.
- `apps/server/src/server.ts` — one `Layer.provide(SqlitePersistenceLayerLive)`,
  explained under _Layer wiring_ below.

## The tools

| Tool            | Caller | Effect                                                                                                |
| --------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `agent_spawn`   | parent | Creates a child thread on the provider its role resolves to, returns a `delegationId`, does not block |
| `agent_handoff` | child  | Records the typed terminal result and notifies the parent                                             |
| `agent_message` | either | Enqueues a durable message; never starts or steers a turn                                             |
| `agent_inbox`   | either | Reads pending messages and the state of delegations you started                                       |

`agent_inbox` exists because nothing pushes a result to a parent. It is the "way
to see it" for the other three.

## Design rules worth keeping

**A delegation's identity is not a thread id.** `delegation_id` is the durable
key; `child_thread_id` is a locator recorded on the row. A thread id changes on
retry and is meaningless after archival, so keying on it would make provider
identity load-bearing.

**Roles name capability; config names a vendor.** `agent_spawn(role: "reviewer")`
resolves through `<stateDir>/orchestration-roles.json`. If the tool call named a
provider, every prompt in the system would encode one vendor and swapping the
backend would mean editing prose across every thread.

There are no default roles. `providerInstanceId` is a per-install value, so
guessing one would silently choose a vendor. Missing config fails closed.

**Silence is never success.** No code path reaches `completed` except an accepted
`agent_handoff`, and a `completed` handoff with an empty `validation` list is
rejected. A child that simply stops leaves its delegation `running`, which is
visible, rather than reporting done. This mirrors `assert_productive_turn` in
scout-rsi, added after a Kimi thread returned empty output and the harness
reported success.

**Leases are opaque strings.** `resource_lease` may be `git:owner/repo#branch`,
a worktree path, or anything else. Orchestration does not know what a pull
request is. Uniqueness is enforced by a partial unique index over live rows, not
a read-then-write check, so concurrent spawns cannot both win.

**Briefs, not transcripts.** The handoff struct is closed and capped at 64 KiB.
Self-hosted routes credit no prompt caching, so context spent early is re-sent on
every later model call in the turn.

**Tool parameters carry their required fields at the top level. This is a rule,
not a preference, and it survived a model upgrade.** One top-level wrapper object
is the failure; nesting below it is fine. See _Top-level parameters_ below; it is
enforced by `flatParameters.test.ts`.

**Messages travel the delegation graph, never to an arbitrary thread.**
`agent_message` is addressed by `delegationId` and will only reach the parent
that spawned you or a child you spawned. Free-form `toThreadId` was removed: it
duplicated something the HTTP dispatch API already does for operators, and it
gave a thread reach it had no relationship to justify. Authority here comes from
the delegation record, which is the only thing this toolkit can actually check.

**This feature governs no worktrees.** It records a worktree path on a delegation
and never deletes anything.

## Roles config

`<stateDir>/orchestration-roles.json`, re-read on every spawn so an operator can
fix a role without restarting:

```json
{
  "maxDepth": 2,
  "roles": {
    "implementer": {
      "providerInstanceId": "opencode",
      "model": "self-hosted-glm/glm-5.2",
      "options": [{ "id": "agent", "value": "build" }],
      "runtimeMode": "full-access",
      "canSpawn": false,
      "deadlineMinutes": 45,
      "instructions": "Bound tool output. Prefer an API over a browser for proof."
    },
    "reviewer": {
      "providerInstanceId": "claudeAgent",
      "model": "claude-opus-5",
      "canSpawn": false
    }
  }
}
```

`canSpawn` defaults to `false`, so a child cannot delegate onward unless its role
says it may. A thread with no delegation row is operator-started and unrestricted.

`options` matters more than it looks: an `opencode` thread selects its agent
there, and omitting it does not fall back to a sensible default so much as make
no choice at all. It was missing from the first version of this config and the
gap was only found by reading real `projection_threads` rows.

`deadlineMinutes` is advisory — see _Deadlines and staleness_.

### Changing which model a role uses

No model or provider string appears anywhere in the toolkit's code; both are data
on the role. Moving `implementer` from GLM 5.2 to 5.3-Flash is one edit here, and
the file is re-read on every spawn, so it needs no restart either.

One caveat that is easy to miss: the role names a `providerInstanceId`, and that
instance has to actually serve the model. At time of writing the `opencode`
instance enables `self-hosted-glm` and `self-hosted-kimi` only, so a 5.3 child
needs a provider entry in OpenCode's own config first. The T3 Code side is
config-only; the provider side is a separate file this toolkit does not own.

## Settling a thread from inside it

`agent_settle_self` takes no arguments and always targets the calling thread,
resolved from the authenticated MCP session. There is no parameter that could
redirect it, which is the same reason `agent_message` addresses by delegation
rather than thread id. Zero required fields also means the tool is immune to the
empty-`{}` failure above: a model cannot get a schema wrong that wants nothing.

### It is deferred, and it has to be

A thread **cannot** settle itself synchronously, and any design that assumes
otherwise will fail 100% of the time. Two separate mechanisms are easy to
conflate:

- **Client-side rendering.** `effectiveSettled()` treats pending approvals, a
  live session, and queued turn starts as hard blockers that beat the stored
  override. This is a display rule, and it is where "the blockers win" is true.
- **Server-side decision.** `decider.ts` _rejects_ `thread.settle` outright when
  `session.status` is `starting` or `running`:
  `thread <id> has an active session and cannot be settled`. The command fails.
  Nothing is recorded.

A thread is `running` for the entire time its own agent is calling tools. From a
real spawn on this branch:

```
22:09:41.080  thread.session-set  status=running
22:09:45.475  tool.started        t3-code_agent_spawn
22:09:46.479  tool.completed      t3-code_agent_spawn
22:09:48.208  thread.session-set  status=ready
```

The tool call sits strictly inside the running window. So a settle dispatched
from a handler is always refused.

`agent_settle_self` therefore attempts the dispatch, and on refusal records the
request in `orchestration_settle_requests` and returns
`{ settled: false, deferredReason: ... }`. That is the ordinary success path, not
an error, and the tool description says so — otherwise a model would read the
`false` as a failure and retry pointlessly.

### Success is read from the projection, never from the receipt

Neither settle path reports on the dispatch result. Both re-read
`projection_threads.settled_override` and report `settled: true` only when it
says `settled`. A receipt means the command was accepted, which is a different
claim, and a tool that reports success while the override stayed unset is the
exact failure shape this toolkit exists to remove.

Over HTTP the same rejection surfaces as an opaque **500** rather than a typed
client error, because `orchestration/http.ts` funnels every dispatch failure
through `failEnvironmentInternal("orchestration_dispatch_failed")`. The decider's
own message — `thread <id> has an active session and cannot be settled` — is
logged server-side with a correlating `traceId`, so it is recoverable, but a
caller sees only "internal error". In-process callers like this toolkit get the
typed error directly and do not depend on that mapping.

### `settled` is not sticky, and that is deliberate

A settle that applied can be undone seconds later. The server emits
`thread.unsettled(reason: "activity")` the moment real work arrives on a settled
thread. Observed in production: two threads settled at 04:48:00 and 04:48:01,
both applied, both auto-unsettled at 04:51:47 and 04:51:59 when a message was
sent to them.

This is worth stating because the evidence for it looks alarming out of context.
A `thread.settled` event with an accepted receipt sitting next to
`settled_override = NULL` reads like a command that was accepted but never
applied. It is not — it is a command that applied and was then correctly
reverted. Distinguishing the two requires the event log; the projection alone
cannot tell you which happened.

### What applies a deferred request

The same opportunistic sweep that handles staleness, for the same reason: the
natural trigger already exists. A parent calling `agent_inbox` to collect a
child's handoff is precisely the moment that child has finished its turn, so
children get tidied by the act of being read. A request whose thread is still
live is skipped, and one the decider refuses for another reason (a pending
approval, a queued turn start) simply stays pending and is retried next sweep.

The same caveat as staleness applies and is worth stating plainly: if no thread
ever calls a toolkit tool, nothing applies. A settle request is durable and
correct whenever it is next examined, but it is not on a timer.

### Why nothing here re-implements the settle rules

The handler dispatches `thread.settle` and lets the decider judge it. The four
invariants (archived, live session, pending approval or user input, queued turn
start) stay in one place, and the server also auto-unsettles a thread when real
activity arrives, so a settled thread that gets more work rejoins the active list
without this toolkit tracking anything.

## Storage

Two tables in the existing `state.sqlite`, created with `IF NOT EXISTS` when the
layer builds: `orchestration_delegations` and `orchestration_messages`.

They are deliberately _not_ numbered migrations. A `044_` file collides with
whatever upstream numbers `044_` next, on every rebase, forever. Lazily created
additive tables cost nothing to carry and nothing to drop.

The write path is ordered for recoverability: the row is inserted `pending` with
its spawn command id _before_ the command is dispatched. Command ids are
deduplicated by `orchestration_command_receipts`, so replaying a `pending` row's
command returns the original sequence instead of creating a second child.

### Why not new orchestration event types

Delegation lifecycle would be a natural fit for `orchestration_events`, but
`OrchestrationEventType` is a closed literal union in `packages/contracts`.
Extending it means editing a shared package on every rebase. Delegation state
therefore lives in its own tables, and the thread timeline gets ordinary
`thread.activity.append` entries (`delegation.spawned`, `delegation.handoff`),
which need no schema change because activity `kind` and `payload` are open.

## Layer wiring

`DelegationStore.layer` requires `SqlClient`. In production that is satisfied by
`runtimeServicesLive`, but upstream's `server.test.ts` builds `makeRoutesLayer`
with a narrower context, so the requirement leaked and broke 256 assertions.

The fix is one line in `server.ts` providing `SqlitePersistenceLayerLive` into
`makeRoutesLayer`, which makes the layer self-contained. Because Effect memoizes
layer construction per build via a `MemoMap`, and both provision points reference
the same module-level layer, this builds **one** client — verified empirically,
not assumed, since `layerConfig` is a `Layer.unwrap` and `setup` runs migrations.
If that line is ever dropped during a rebase, `server.test.ts` will fail to
typecheck, which is the signal to restore it.

## Top-level parameters

**Any tool in this toolkit must carry its required fields at the top level of
`parameters`. One wrapper object around them is the failure.** Nesting _below_
the top level is fine — an array of objects is a measured-good shape. This
applies to every tool added later, not just the ones here now.

### The measurement

Same prompt, same tool, five runs each, the only variable being one level of
top-level wrapping:

| `parameters` shape                                           | GLM 5.2  | GLM 5.3-Flash |
| ------------------------------------------------------------ | -------- | ------------- |
| required fields at top level (including an array of objects) | —        | **5/5 valid** |
| identical fields wrapped in one top-level object             | **0/23** | **3/5 valid** |

Two things to take from this.

**Upgrading the model does not remove the constraint.** 5.3-Flash is dramatically
better and still fails roughly 40% of the time on the wrapped shape. Anyone
tempted to relax this rule because the implementer got smarter should read the
middle column and then the right-hand one.

**The rule is narrower than "no nested objects."** An array of objects with their
own required fields passed 5/5. Destructuring such an array into parallel scalar
arrays would make tools meaningfully worse to use — `agent_handoff`'s validation
entries being the obvious case — for no measured benefit. `flatParameters.test.ts`
therefore inspects only top-level properties, and carries an explicit test
asserting that an array of objects is permitted, so the rule cannot quietly be
re-tightened.

### The 5.2 anecdote, which is where this started

On the first live spawn, `agent_handoff` took
`{ handoff: { ...six fields... } }`. A self-hosted GLM 5.2 implementer failed **23
consecutive calls** against it. Every failure was the same:

```
Invalid input for tool t3-code_agent_handoff: JSON parsing failed:
Text: {"handoff": {"status": "completed", "summary": "Fixed calc.py ...
Error message: JSON Parse error: Expected '}'
```

The model was not confused about the task. It had already fixed the bug, run the
verification, and reached the delegated judgment. It composed correct content
every time and could not close two levels of braces. Its transcript shows it
diagnosing the problem correctly — _"The schema indicates the fields go directly,
not nested under handoff"_ — and then, trying to appease the parser, stripping
quotes out of its own evidence strings until they no longer described what it had
run. It never recovered and had to be interrupted.

Flattening the parameters took the retry count from 23 to **0** on the next run,
same model, same task, same prompt.

### On 5.3-Flash the same fault is silent, which is worse

5.2 failed loudly: a parse error the model could see and react to, even if it
never recovered. The two 5.3-Flash failures emitted a **well-formed tool call
with empty `{}` arguments**. Nothing raises. A model that calls a tool with no
arguments is indistinguishable, from the outside, from a model that declined to
call it at all — and the visible consequence is a delegation sitting `running`
with no handoff.

That is why the staleness sweep counts rejected handoff attempts and reports
`handoff_attempted_but_rejected` as its own verdict. "Tried to report and the
tool shape defeated it" and "never tried" need different responses, and without
the count they are the same row.

Why this is a rule and not a bug report: the intended shape of this system is a
capable coordinator (Cursor, Grok) driving self-hosted implementers, because
self-hosted is free at the margin and therefore the right default for long
autonomous work. That makes reliable tool-call emission by a small model a
load-bearing property of the whole design, not a quirk of one tool. A nested
parameter is a tax paid on the single call that must not fail — the one where the
child reports what it did.

`flatParameters.test.ts` walks each tool's generated JSON schema and fails on any
nested object property. It also asserts that every registered tool is covered, so
a tool added later cannot quietly skip the rule.

## Deadlines and staleness

A delegation that is honest but unnoticed is no better than one that lies. The
failure this is designed against, from the harness that preceded this one: intake
tasks sitting `working` for up to fourteen days while a sweep refreshed their
heartbeat on every scan, `last_progress_at` never moving, and the recovery path
keying off the wrong column so `retry_count` stayed at zero.

The structural answer is in `staleness.ts`: **progress is read, never written.**

- `lastActivityAt` and `latestTurnState` are subqueries over
  `projection_thread_activities` and `projection_turns` for the _child_ thread —
  projections this toolkit does not own and cannot touch.
- There is no `heartbeat_at` column and `updated_at` is deliberately not an
  input. This toolkit bumps `updated_at` on every write, so keying off it would
  mean a delegation looks freshest exactly when we last looked at it.
- `staleness.test.ts` asserts the shape of the progress record itself, so adding
  a self-written freshness field is a test failure rather than a silent
  regression.

Four verdicts, and only two act on their own:

| Reason                             | Auto-fails | Why                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handoff_attempted_but_rejected`   | yes        | The child called the handoff tool, had its arguments rejected every time, and stopped. Reported separately because the fix differs: it tried, and the tool call defeated it. Counting rejected tool-call activities on the child thread is the only way the silent empty-arguments failure is distinguishable from never calling. |
| `child_turn_ended_without_handoff` | yes        | The child's turn is terminal, no handoff was accepted, and no rejected attempt was recorded. It is not coming back; failing frees the lease and tells the parent something true. No clock involved.                                                                                                                               |
| `never_started`                    | yes        | Recorded but never bound to a child thread, so the spawn crashed mid-write. The command id can be replayed.                                                                                                                                                                                                                       |
| `overdue`                          | no         | Past its `deadlineMinutes` budget. A slow child and a hung one look identical from here, and only one of them should be cut off.                                                                                                                                                                                                  |
| `no_progress`                      | no         | Nothing observable on the child thread for the stall window. Same caution.                                                                                                                                                                                                                                                        |

The deterministic verdict is checked before any clock-based one, so a stalled
delegation is reported for the reason that can be proven.

Alerting is one-shot per delegation (`alerted_at`), because an alert that
re-fires every sweep is the same noise as a heartbeat that never moves. It lands
in two places: a durable inbox message to the parent, and a `delegation.stalled`
activity on the parent's thread, which is visible in the T3 Code UI without
anyone calling a tool.

**The sweep runs on tool invocation, not on a timer**, from `agent_inbox` (so a
read never reports a stale delegation as fine) and from `agent_spawn` (so a dead
child does not hold a lease against its own replacement). A fork should not own a
scheduler, and a self-running sweep is precisely the thing that tends to acquire
the habit of writing its own freshness. The cost is real and worth stating: if no
thread ever calls a tool, nothing sweeps. What that buys is that staleness is
derived on every read and can never be _hidden_ — only unobserved.

## What the first live spawn cost

The unit suite was green before this feature had ever run against a provider. The
first real spawn — a GLM parent delegating to a GLM child over the self-hosted
route — found two defects the suite could not.

**Roles could not express model options.** Real threads carry
`options: [{"id": "agent", "value": "build"}]` in their `modelSelection`;
`RoleDefinition` had no field for it. Found by reading actual
`projection_threads` rows rather than the schema.

**`agent_handoff` was nested, and the child could not close the braces.** The
tool took `{ handoff: { ...six fields... } }`. The child fixed the bug correctly,
reached the right judgment, and then failed 23 consecutive handoff calls, every
one returning `JSON Parse error: Expected '}'`. It began stripping quotes out of
its own evidence strings trying to satisfy the parser, and had to be interrupted.
Flattening the parameters took the retry count to zero on the next run.

The structural guard behaved exactly as designed through all of this: with no
accepted handoff the delegation stayed `running`, never `completed`. The work was
done and the report was lost, and the record said so. That is the outcome the
design is for — but note that the guard reports the failure, it does not prevent
it, and a delegation stuck `running` needs an operator or a timeout to notice.

## This toolkit is a safer default, not a security boundary

Read this before treating `agent_spawn` as a containment mechanism. It is not
one, and the gap is not subtle.

The MCP credential a tool call arrives on is genuinely narrow: minted per thread
by the server, revoked when the provider session ends, carrying no terminal,
review, or relay authority. A model that delegates through this toolkit is doing
the least-privileged thing available to it, and the delegation record makes what
it did auditable afterwards.

**But nothing stops the same model from shelling out instead.** A single
`t3 auth session issue` returns one token carrying, in one bundle:

```
orchestration:read   orchestration:operate   terminal:operate   review:write
relay:read           relay:write             access:read        access:write
```

There is no way to request a subset. So a model with shell access does not merely
escalate past this toolkit — it obtains terminal execution and review-write
authority in the same step, and can then drive threads directly over
`POST /api/orchestration/dispatch` with no delegation record written anywhere.

That surface is upstream's and is not fixed here (see below). The honest framing:
this toolkit makes the well-behaved path cheap, legible, and recorded. It raises
no wall. Any argument that begins "a child cannot do X because the toolkit
prevents it" is wrong; the correct form is "a child that uses the toolkit leaves
a record, and one that does not is indistinguishable from an operator."

## Known upstream weaknesses, deliberately not fixed here

Both are real. Both are scoped to a single-user local instance, and fixing either
means owning an upstream review conversation we do not want right now. Recorded
so they are not lost.

1. **Dispatch authorization is all-or-nothing, and so is token issuance.**
   `POST /api/orchestration/dispatch` authenticates every command against one
   scope (`authenticateRawRouteWithScope(AuthOrchestrationOperateScope)`), so any
   holder of `orchestration:operate` can create, interrupt, or delete any thread.
   Worse, `t3 auth session issue` mints that scope only as part of a fixed bundle
   that also includes `terminal:operate`, `review:write`, `relay:read/write`, and
   `access:read/write`, with no way to ask for less. A narrower
   `orchestration:delegate` scope, and scope selection at issuance, would let a
   delegated child hold strictly less authority than its parent. Today it cannot.

2. **Actor identity is inferred from a client-supplied string.** `inferActorKind`
   returns `"server"` when `commandId` starts with `server:`, and `"provider"` on
   a `provider:` prefix. Anything that can dispatch can therefore choose how its
   events are attributed. Actor kind should be stamped server-side from the
   authenticated session.

Note that the MCP capability set is currently uniform — `McpSessionRegistry`
issues `new Set(["preview"])` for every thread — so adding a `"delegate"`
capability there would be decoration, not a gate. Real gating in this feature
comes from the roles config (`canSpawn`, `maxDepth`), which is per-role and
fails closed.

## Relationship to the scout-rsi prose guards

scout-rsi's `_lane_request_patterns` detects, by regex over English, a prompt
routing routine work into the contract lane. It caught five live prompts in one
day, so it stays until the capability model demonstrably covers that case.

`canSpawn` is the intended replacement: a role that cannot spawn cannot route
work anywhere, so there is nothing to detect after the fact. Retire the regexes
only after a capability-gated run reproduces that specific leak and refuses it.
