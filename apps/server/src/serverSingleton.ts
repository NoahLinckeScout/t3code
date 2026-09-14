/**
 * One server per data directory.
 *
 * Two T3 Code servers pointed at the same `--base-dir` both open `state.sqlite`
 * and both write `settings.json`, and they overwrite each other. The observed
 * incident: a desktop app auto-updated to a newer server while the old one was
 * still running, the new process found its port taken, silently bound a random
 * one, and ran blind against shared state. The visible symptom was a settings
 * toggle that would not stick — hours away from the actual cause.
 *
 * Nothing about that is detectable after the fact, so the fix is to refuse at
 * startup. A second server against a held directory exits with one clear
 * message instead of corrupting state.
 *
 * ## Why a pid file rather than `flock`
 *
 * An advisory `flock` is the better primitive: the kernel drops it when the
 * holder dies, so a crashed server leaves nothing stale to clean up. Node has no
 * binding for it, and adding a native dependency to the server for one lock is a
 * worse trade than handling staleness here.
 *
 * So the lock is an atomically created file holding the owner's identity, and
 * liveness is checked with signal 0. The tradeoff is honest: if a server is
 * killed and its pid is later reused by an unrelated process, this refuses to
 * start until the file is removed. A lock that cannot be read at all is treated
 * the same way — never auto-reclaimed, because a half-written file may belong
 * to a server that is starting right now. That is the safe direction to fail,
 * and the message names the file so recovery is one `rm`.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const SERVER_LOCK_FILENAME = "server.lock";

export const ServerLockHolder = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  startedAt: Schema.String,
  /** Absent until the server binds; the lock is taken before a port exists. */
  port: Schema.optional(Schema.Int),
});
export type ServerLockHolder = typeof ServerLockHolder.Type;

const ServerLockHolderFromJson = Schema.fromJsonString(ServerLockHolder);
const decodeHolder = Schema.decodeUnknownOption(ServerLockHolderFromJson);
const encodeHolder = Schema.encodeSync(ServerLockHolderFromJson);

export class ServerAlreadyRunningError extends Schema.TaggedErrorClass<ServerAlreadyRunningError>()(
  "ServerAlreadyRunningError",
  {
    stateDir: Schema.String,
    lockPath: Schema.String,
    holderPid: Schema.Int,
    holderPort: Schema.optional(Schema.Int),
    holderStartedAt: Schema.String,
  },
) {
  override get message(): string {
    const where =
      this.holderPort === undefined
        ? `pid ${this.holderPid}`
        : `pid ${this.holderPid}, listening on port ${this.holderPort}`;
    return [
      "Another T3 Code server is already using this data directory.",
      "",
      `  data directory: ${this.stateDir}`,
      `  held by:        ${where}`,
      `  since:          ${this.holderStartedAt}`,
      "",
      "Two servers sharing one data directory overwrite each other's state.sqlite",
      "and settings.json. Stop the running server, or start this one with a",
      "different --base-dir.",
      "",
      `If that process is gone, remove ${this.lockPath} and start again.`,
    ].join("\n");
  }
}

export class ServerLockUnavailableError extends Schema.TaggedErrorClass<ServerLockUnavailableError>()(
  "ServerLockUnavailableError",
  {
    lockPath: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Could not claim the server lock at ${this.lockPath}: ${this.reason}`;
  }
}

/**
 * Whether a pid is a live process.
 *
 * `EPERM` means it exists and belongs to someone else, which still counts — a
 * server started under a different user is exactly the case that must not be
 * trampled.
 */
export const processIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The lock file's raw contents, or `undefined` when it does not exist. */
const readLockFile = Effect.fn("serverSingleton.readLockFile")(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(lockPath).pipe(Effect.option);
});

const readHolder = Effect.fn("serverSingleton.readHolder")(function* (lockPath: string) {
  const raw = yield* readLockFile(lockPath);
  if (Option.isNone(raw)) return undefined;
  return Option.getOrUndefined(decodeHolder(raw.value));
});

/**
 * Claims the directory, or explains who holds it.
 *
 * A lock whose holder decodes but is dead is taken over by renaming the file
 * aside — atomic, so two reclaimers cannot both remove-and-recreate their way
 * to two winners — and re-racing the exclusive create. An *unreadable* lock is
 * a different situation: it is either a crash-torn file or another starting
 * server whose exclusive create has landed but whose contents are still being
 * written, and the two cannot be distinguished. The second case is live, so an
 * unreadable lock is never reclaimed; we poll until the publish settles, and
 * refuse if it never does.
 */
const claimLock = Effect.fn("serverSingleton.claimLock")(function* (input: {
  readonly stateDir: string;
  readonly lockPath: string;
  readonly startedAt: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const payload = encodeHolder({ version: 1, pid: process.pid, startedAt: input.startedAt });
  // Suffixed with our pid: two concurrent reclaimers rename to different trash
  // names, so neither can clobber the other's take.
  const trashPath = `${input.lockPath}.reclaimed.${process.pid}`;
  let unreadablePolls = 0;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    yield* fs.makeDirectory(path.dirname(input.lockPath), { recursive: true }).pipe(Effect.ignore);
    const created = yield* fs.writeFileString(input.lockPath, payload, { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (created) {
      // Winning the create wins the pathname, not the argument. A reclaimer
      // that read the previous holder as dead can still rename our file aside
      // in the instant before this read; if it did, we lost and re-evaluate.
      const ours = yield* readHolder(input.lockPath);
      if (ours !== undefined && ours.pid === process.pid) return undefined;
      continue;
    }

    const raw = yield* readLockFile(input.lockPath);
    if (Option.isNone(raw)) continue; // Removed under us: the pathname is free, race the create again.

    const holder = Option.getOrUndefined(decodeHolder(raw.value));
    if (holder !== undefined && processIsAlive(holder.pid)) {
      return new ServerAlreadyRunningError({
        stateDir: input.stateDir,
        lockPath: input.lockPath,
        holderPid: holder.pid,
        ...(holder.port === undefined ? {} : { holderPort: holder.port }),
        holderStartedAt: holder.startedAt,
      });
    }
    if (holder === undefined) {
      unreadablePolls += 1;
      if (unreadablePolls > 5) {
        return new ServerLockUnavailableError({
          lockPath: input.lockPath,
          reason:
            "its contents never became a readable holder, so a concurrent start and a crash-torn write cannot be told apart; if no server is starting or running, remove the file manually and start again",
        });
      }
      yield* Effect.sleep("50 millis");
      continue;
    }
    // Owner is gone. Take the pathname atomically rather than deleting it, so a
    // concurrent reclaimer's create fails against ours instead of erasing it.
    yield* fs.rename(input.lockPath, trashPath).pipe(Effect.ignore);
    yield* fs.remove(trashPath).pipe(Effect.ignore);
  }
  return new ServerLockUnavailableError({
    lockPath: input.lockPath,
    reason: "the lock kept changing hands while it was being claimed",
  });
});

/** Releases only a lock this process still owns, so a reclaimer is never evicted. */
export const releaseServerLock = Effect.fn("serverSingleton.release")(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const holder = yield* readHolder(lockPath);
  if (holder !== undefined && holder.pid !== process.pid) return;
  yield* fs.remove(lockPath).pipe(Effect.ignore);
});

/**
 * Records the bound port on the lock we already hold.
 *
 * Only for the error message a *later* server prints: knowing the holder's port
 * turns "something else is running" into an address the user can open. Failure
 * is ignored — the lock's job is done once it is held.
 */
export const recordServerLockPort = Effect.fn("serverSingleton.recordPort")(function* (
  lockPath: string,
  port: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const holder = yield* readHolder(lockPath);
  if (holder === undefined || holder.pid !== process.pid) return;
  // Rewrite through a temp file + rename: the lock path never holds a
  // truncated or partial holder, so a concurrent starter reading it sees
  // either the previous complete holder or this one — never an unparsable
  // middle that looks stale enough to reclaim.
  const tempPath = `${lockPath}.port.${process.pid}`;
  yield* fs.writeFileString(tempPath, encodeHolder({ ...holder, port })).pipe(Effect.ignore);
  yield* fs.rename(tempPath, lockPath).pipe(
    Effect.catch(() => fs.remove(tempPath).pipe(Effect.ignore)),
  );
});

export const serverLockPath = Effect.fn("serverSingleton.lockPath")(function* (stateDir: string) {
  const path = yield* Path.Path;
  return path.join(stateDir, SERVER_LOCK_FILENAME);
});

/**
 * Holds the data directory for the lifetime of the returned scope.
 *
 * Acquired before anything opens the database or binds a port, and released on
 * shutdown.
 */
export const acquireServerSingleton = Effect.fn("serverSingleton.acquire")(function* (
  stateDir: string,
) {
  const lockPath = yield* serverLockPath(stateDir);
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const failure = yield* claimLock({ stateDir, lockPath, startedAt });
      if (failure !== undefined) return yield* failure;
      return lockPath;
    }),
    () => releaseServerLock(lockPath).pipe(Effect.ignore),
  );
});
