// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
}

export class RotatingFileSinkConfigurationError extends Schema.TaggedError<RotatingFileSinkConfigurationError>()(
  "RotatingFileSinkConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles"]),
    received: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.option} must be >= ${this.minimum} (received ${this.received})`;
  }
}

export class RotatingFileSinkError extends Schema.TaggedError<RotatingFileSinkError>()(
  "RotatingFileSinkError",
  {
    operation: Schema.Literals(["initialize", "read", "write", "rotate", "prune"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} rotating log file ${this.filePath}`;
  }
}

const isRotatingFileSinkError = Schema.is(RotatingFileSinkError);

const isFileNotFoundError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private currentSize = 0;

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new RotatingFileSinkConfigurationError({
        option: "maxBytes",
        received: options.maxBytes,
        minimum: 1,
      });
    }
    if (options.maxFiles < 1) {
      throw new RotatingFileSinkConfigurationError({
        option: "maxFiles",
        received: options.maxFiles,
        minimum: 1,
      });
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;

    try {
      NodeFS.mkdirSync(NodePath.dirname(this.filePath), { recursive: true });
    } catch (cause) {
      throw new RotatingFileSinkError({
        operation: "initialize",
        filePath: this.filePath,
        cause,
      });
    }
    this.pruneOverflowBackups();
    this.currentSize = this.readCurrentSize();
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;

    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        this.rotate();
      }

      NodeFS.appendFileSync(this.filePath, buffer);
      this.currentSize += buffer.length;
    } catch (cause) {
      if (isRotatingFileSinkError(cause)) {
        throw cause;
      }
      if (this.throwOnError) {
        throw new RotatingFileSinkError({
          operation: "write",
          filePath: this.filePath,
          cause,
        });
      }
      this.currentSize = this.readCurrentSize();
    }
  }

  // Append through the fs thread pool so a busy or contended disk never blocks
  // the caller's event loop the way the synchronous write() does. Writes are
  // serialized per sink, so size accounting and rotation stay consistent; do not
  // interleave write() and writeAsync() on one sink, or ordering breaks.
  private writeChain: Promise<void> = Promise.resolve();

  writeAsync(chunk: string | Buffer): Promise<void> {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return Promise.resolve();
    const result = this.writeChain.then(() => this.appendAsync(buffer));
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves once every writeAsync scheduled so far was written or failed. */
  flushAsync(): Promise<void> {
    return this.writeChain;
  }

  private async appendAsync(buffer: Buffer): Promise<void> {
    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        await this.rotateAsync();
      }
      await NodeFS.promises.appendFile(this.filePath, buffer);
      this.currentSize += buffer.length;
    } catch (cause) {
      try {
        this.currentSize = this.readCurrentSize();
      } catch {
        // keep the stale estimate; the next write retries the read
      }
      if (this.throwOnError) {
        throw new RotatingFileSinkError({
          operation: "write",
          filePath: this.filePath,
          cause,
        });
      }
    }
  }

  private async rotateAsync(): Promise<void> {
    const oldest = this.withSuffix(this.maxFiles);
    if (NodeFS.existsSync(oldest)) {
      await NodeFS.promises.rm(oldest, { force: true });
    }

    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = this.withSuffix(index);
      if (NodeFS.existsSync(source)) {
        await NodeFS.promises.rename(source, this.withSuffix(index + 1));
      }
    }

    if (NodeFS.existsSync(this.filePath)) {
      await NodeFS.promises.rename(this.filePath, this.withSuffix(1));
    }

    this.currentSize = 0;
  }

  private rotate(): void {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      if (NodeFS.existsSync(oldest)) {
        NodeFS.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (NodeFS.existsSync(source)) {
          NodeFS.renameSync(source, target);
        }
      }

      if (NodeFS.existsSync(this.filePath)) {
        NodeFS.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
    } catch (cause) {
      if (this.throwOnError) {
        throw new RotatingFileSinkError({
          operation: "rotate",
          filePath: this.filePath,
          cause,
        });
      }
      this.currentSize = this.readCurrentSize();
    }
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = NodePath.dirname(this.filePath);
      const baseName = NodePath.basename(this.filePath);
      for (const entry of NodeFS.readdirSync(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        NodeFS.rmSync(NodePath.join(dir, entry), { force: true });
      }
    } catch (cause) {
      if (this.throwOnError) {
        throw new RotatingFileSinkError({
          operation: "prune",
          filePath: this.filePath,
          cause,
        });
      }
    }
  }

  private readCurrentSize(): number {
    try {
      return NodeFS.statSync(this.filePath).size;
    } catch (cause) {
      if (isFileNotFoundError(cause)) {
        return 0;
      }
      throw new RotatingFileSinkError({
        operation: "read",
        filePath: this.filePath,
        cause,
      });
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}
