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

**Tool parameters are flat. This is a rule, not a preference.**
See _Flat parameters_ below; it is enforced by `flatParameters.test.ts`.

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

## Flat parameters

**Any tool in this toolkit takes a flat argument object. No parameter may be a
nested object.** Arrays of scalars are fine. This applies to every tool added
later, not just the ones here now.

The evidence. On the first live spawn, `agent_handoff` took
`{ handoff: { ...six fields... } }`. A self-hosted GLM implementer failed **23
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

| Reason                             | Auto-fails | Why                                                                                                                                                              |
| ---------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `child_turn_ended_without_handoff` | yes        | The child's turn is terminal and no handoff was accepted. It is not coming back; failing frees the lease and tells the parent something true. No clock involved. |
| `never_started`                    | yes        | Recorded but never bound to a child thread, so the spawn crashed mid-write. The command id can be replayed.                                                      |
| `overdue`                          | no         | Past its `deadlineMinutes` budget. A slow child and a hung one look identical from here, and only one of them should be cut off.                                 |
| `no_progress`                      | no         | Nothing observable on the child thread for the stall window. Same caution.                                                                                       |

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
