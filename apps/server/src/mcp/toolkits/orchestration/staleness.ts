/**
 * Deciding when a delegation has stopped making progress.
 *
 * ## Why none of this is a heartbeat
 *
 * The failure being designed against: intake tasks that sat `working` for up to
 * fourteen days while a sweep refreshed their heartbeat on every scan. The
 * record looked alive because the thing checking liveness was also the thing
 * writing it, and the column that actually tracked work never moved.
 *
 * So this module reads progress and never writes it. `lastActivityAt` and
 * `latestTurnState` are derived per query from the child thread's own
 * projections — rows this toolkit does not own and cannot touch. There is no
 * `heartbeat_at`, and the sweep is forbidden from updating anything that feeds
 * back into its own staleness decision. `updated_at` is deliberately not an
 * input here: this toolkit bumps it on every write, so keying off it would mean
 * a delegation looks fresh precisely because we just looked at it.
 */
import type { DelegationState } from "./schemas.ts";

/** Turn states from which a child will not resume on its own. */
const TERMINAL_TURN_STATES: ReadonlySet<string> = new Set(["completed", "interrupted", "error"]);

export const LIVE_DELEGATION_STATES: ReadonlySet<DelegationState> = new Set(["pending", "running"]);

/** How long a live delegation may show no observable work before it is stalled. */
export const DEFAULT_STALL_WINDOW_MS = 30 * 60 * 1000;

export type StaleReason =
  /**
   * The child called the handoff tool and had its arguments rejected, then
   * stopped. Distinguished from plain abandonment because it is a different
   * problem with a different fix: the child tried to report and the tool shape
   * defeated it. Self-hosted implementers emit well-formed calls with empty
   * arguments often enough that this must not read as "never tried".
   */
  | "handoff_attempted_but_rejected"
  /**
   * The child's turn reached a terminal state and no handoff was ever accepted.
   * Deterministic: no clock, no threshold, no false positive from a slow model.
   * This is the run-one failure — a child that did the work, could not report,
   * and left a delegation that would have read `running` forever.
   */
  | "child_turn_ended_without_handoff"
  /** Dispatched but never bound to a child thread: the spawn crashed mid-write. */
  | "never_started"
  /** Past its wall-clock budget, whatever it is doing. */
  | "overdue"
  /** Still nominally running, but nothing observable has happened in a while. */
  | "no_progress";

export interface DelegationProgress {
  readonly state: DelegationState;
  readonly childThreadId: string | null;
  /** Latest turn state on the child thread, or null when it has no turns yet. */
  readonly latestTurnState: string | null;
  /** Newest activity timestamp on the child thread. Derived, never stored. */
  readonly lastActivityAt: string | null;
  readonly createdAt: string;
  readonly deadlineAt: string | null;
  readonly rejectedHandoffAttempts: number;
}

export interface StaleVerdict {
  readonly reason: StaleReason;
  /**
   * Whether this verdict is safe to act on without judgment. Only the
   * deterministic case is: a child whose turn ended is not coming back, so
   * failing the delegation frees its lease and tells the parent something true.
   * A slow or overdue child might still be working, so those only alert.
   */
  readonly autoFail: boolean;
  readonly detail: string;
}

const parseMs = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * Classify one live delegation. Returns undefined when it is fine, or terminal.
 *
 * Ordering is deliberate: the deterministic signal is checked before any
 * clock-based one, so a stalled delegation is reported for the reason we can
 * prove rather than the reason that happened to trip first.
 */
export const classifyDelegation = (
  progress: DelegationProgress,
  nowIso: string,
  stallWindowMs: number = DEFAULT_STALL_WINDOW_MS,
): StaleVerdict | undefined => {
  if (!LIVE_DELEGATION_STATES.has(progress.state)) return undefined;

  if (progress.childThreadId !== null && progress.latestTurnState !== null) {
    if (TERMINAL_TURN_STATES.has(progress.latestTurnState)) {
      // More specific first: "tried and was rejected" and "never tried" look the
      // same in the delegation record but need different responses.
      return progress.rejectedHandoffAttempts > 0
        ? {
            reason: "handoff_attempted_but_rejected",
            autoFail: true,
            detail: `The child called the handoff tool ${progress.rejectedHandoffAttempts} time(s) and had its arguments rejected every time, then stopped. The work may well be done and the report was defeated by the tool call itself.`,
          }
        : {
            reason: "child_turn_ended_without_handoff",
            autoFail: true,
            detail: `The child thread's turn is ${progress.latestTurnState} and no handoff was accepted. The work may well be done; the report was never made.`,
          };
    }
  }

  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return undefined;

  const created = parseMs(progress.createdAt);
  if (progress.childThreadId === null) {
    return created !== undefined && now - created > stallWindowMs
      ? {
          reason: "never_started",
          autoFail: true,
          detail:
            "The delegation was recorded but never bound to a child thread, so the spawn did not complete. Its command id can be replayed.",
        }
      : undefined;
  }

  const deadline = parseMs(progress.deadlineAt);
  if (deadline !== undefined && now > deadline) {
    return {
      reason: "overdue",
      autoFail: false,
      detail: `Past its deadline of ${progress.deadlineAt}. It may still be working; this needs a look rather than an automatic verdict.`,
    };
  }

  // Fall back to the child's own newest activity. A child with a running turn
  // and no activity at all is judged from when the delegation started.
  const lastProgress = parseMs(progress.lastActivityAt) ?? created;
  if (lastProgress !== undefined && now - lastProgress > stallWindowMs) {
    return {
      reason: "no_progress",
      autoFail: false,
      detail: `No observable activity on the child thread since ${progress.lastActivityAt ?? progress.createdAt}.`,
    };
  }

  return undefined;
};
