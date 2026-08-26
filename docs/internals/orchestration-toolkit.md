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
      "model": "self-hosted-glm",
      "runtimeMode": "full-access",
      "canSpawn": false,
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

## Known upstream weaknesses, deliberately not fixed here

Both are real. Both are scoped to a single-user local instance, and fixing either
means owning an upstream review conversation we do not want right now. Recorded
so they are not lost.

1. **Dispatch authorization is all-or-nothing.** `POST /api/orchestration/dispatch`
   authenticates every command against one scope
   (`authenticateRawRouteWithScope(AuthOrchestrationOperateScope)`). Any holder of
   `orchestration:operate` can create, interrupt, or delete any thread. A narrower
   `orchestration:delegate` scope would let a delegated child hold strictly less
   authority than its parent.

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
