# Provider turn accounting (fork-local)

Fork-only, in `NoahLinckeScout/t3code`. Not proposed upstream.

## The problem

Five threads died mid-turn against `cursor-agent`. Every one of them was recorded
as `projection_turns.state = 'completed'`. Threads that had crashed looked idle,
and the deaths had to be found by reading transcript text rather than by querying
state.

A harness that records a failure as a success is the failure mode this fork
exists to remove, so the accounting is fixed here even though the underlying
transport fault is not ours.

## What actually happens, from the provider event log

The RST originates upstream at Cursor. `cursor-agent` speaks Connect-RPC over
HTTP/2, receives an `RST_STREAM` with code `CANCEL (0x8)`, and maps it to Connect
`Canceled`. T3 Code has no gRPC client on that path — it passes the CLI's output
through ACP — so there is no keepalive or timeout here that would prevent it.

What matters for accounting is how the CLI reports it. On every one of these
turns the log shows:

```
"method":"session/prompt","status":"succeeded"
"type":"turn.completed"  "state":"completed"  "stopReason":"end_turn"
```

`session/prompt` **succeeds**. The stop reason is `end_turn`, identical to a
healthy turn. The session status goes to `ready` with `lastError: null`, and
`settledTurnStateForSessionStatus("ready")` correctly settles the turn as
`completed`. Every layer behaved correctly on the input it was given. The input
was wrong.

The only trace of the failure anywhere in the stream is a line of assistant text
emitted just before the stream ends:

```
Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)
Error: RetriableError: [resource_exhausted] Error
```

## The fix

`transportFailure.ts` classifies the trailing text of a finished turn. When the
turn's **last non-empty line** is a provider error line, `CursorAdapter` emits
`turn.completed` with `state: "failed"` and an `errorMessage` instead of
`state: "completed"`.

Nothing downstream needed changing: `failed` already maps to session status
`error`, which already maps to turn state `error`, and `errorMessage` already
becomes `lastError`. The adapter was the only place that never produced the
value.

### Why this is text matching, and why that is acceptable here

There is no structured signal to key off — no ACP error response, no non-`ready`
session status, no `lastError`. The choice is between reading the one signal the
provider does send and continuing to record these as successes.

This is not policing model prose. The string is emitted by a known program in a
fixed format and is parsed the way compiler output is parsed. The error class and
status code are captured rather than enumerated, so an unseen code is classified
rather than silently missed.

The false positive is real and was observed: while these deaths were happening, a
coordinator thread was diagnosing them and quoting the exact line in its own
output. Matching anywhere in the text would have marked that healthy turn as
failed. Hence the rule is **last non-empty line**, which a thread writing
analysis never satisfies because it keeps writing afterwards. Both directions are
covered by tests in `CursorAdapter.test.ts` driving the real mock ACP agent.

Only the trailing 4 KiB of a turn is retained, so this costs the same on a turn
that streams megabytes.

## The other half: unmodelled provider output is no longer discarded

`AcpRuntimeModel.parseSessionUpdateEvent` used to end like this:

```ts
case "agent_message_chunk": {
  if (upd.content.type === "text" && upd.content.text.length > 0) { /* emit */ }
  break;
}
default:
  break;
```

Two silent discards. An `agent_message_chunk` whose content was not plain text
produced nothing, and **every session update variant this build does not model
was dropped with no trace at all**.

That second one matters more than it looks. ACP content blocks include
`resource_link`, which carries `title` and `description` — precisely where a
provider would put the human-readable half of an error it otherwise reports as a
bare code — and every block carries `_meta`, the protocol's blessed extensibility
channel. A vendor extension using either would have vanished here.

It was also unrecoverable after the fact, because native payload logging
summarises values away:

```ts
function summarizePayload(payload) { ... return { valueType: "object", fieldCount: ... } }
```

So the logs record that _something_ arrived and never what it said. Grepping them
for a missing error string can only ever return nothing, which is not evidence
that nothing was sent.

Now:

- `contentBlockText` renders `resource_link` (title, description, uri) and
  embedded text `resource` blocks into the transcript instead of dropping them.
- Binary blocks are still not inlined, but are **reported** rather than dropped.
- An unmodelled `sessionUpdate` variant is reported with a bounded excerpt of its
  payload.
- `AcpSessionRuntime` logs any such discard at warning level with the variant
  name and excerpt.

This is shared by the Cursor and Grok adapters, both of which speak ACP.

## What still could not be fixed here: the missing error detail

A `[resource_exhausted]` failure was reasonably read as hitting a Cursor account
limit, when Cursor's own `ErrorDetails` reportedly said _"Unable to reach the
model provider... This might be temporary"_ — provider reachability, not quota.

That richer wording **never reaches T3 Code**. The complete assistant text for
that turn, verbatim, is:

```
Error: RetriableError: [resource_exhausted] Error
```

The whole detail is the word `Error`, and the phrase "Unable to reach the model
provider" appears in no provider-authored message in the database.

**That is weaker evidence than it first appears, and an earlier version of this
document overstated it.** The conclusion drawn then — "`cursor-agent` never sent
them" — rested partly on grepping provider event logs, which
`summarizePayload` strips of all values before writing. Those logs could not have
contained the string whatever the agent sent. Combined with the silent `default:
break` above, a richer error carried on an unmodelled update variant would have
left exactly the same trace as never having been sent: none.

What is actually established: the _assistant text_ Cursor produced for that turn
was the short line, and the `session/prompt` result carried a single field
(`fieldCount: 1`, the stop reason). What is not established is whether anything
richer arrived on a channel this build discarded.

The discard reporting above closes that gap going forward. The next occurrence
logs the variant and a bounded excerpt, which answers the question with evidence
instead of inference. Until one occurs, "Cursor sent nothing richer" should be
treated as unproven rather than false.

`transportFailureMessage` therefore preserves the provider's line verbatim and,
when the detail is empty or the bare word `Error`, says so explicitly rather than
substituting a friendlier gloss. A reader who sees "with no further detail" can
tell the provider said nothing useful, instead of inferring a quota.

## Not done deliberately: retries

`cursor-agent` labels `CANCEL` retriable and then runs with
`enableAgentRetries: false`. Whether that is flippable was not verified, and
retrying would mask the drops rather than account for them. Accounting first.
