import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type FileSystemPathInspection =
  | { status: "present"; stats: fs.Stats }
  | { status: "missing" }
  | { status: "inconclusive"; error: unknown };

export function inspectFileSystemPathSync(filePath: string): FileSystemPathInspection {
  try {
    return { status: "present", stats: fs.lstatSync(filePath) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
    return { status: "inconclusive", error };
  }
}

export type ExclusiveFileLockFailure =
  | "invalid_options"
  | "invalid_callback"
  | "acquire_failed"
  | "timeout"
  | "initialize_failed"
  | "release_failed";

export class ExclusiveFileLockError extends Error {
  readonly reason: ExclusiveFileLockFailure;
  readonly lockPath: string;
  readonly cleanupError?: unknown;

  constructor(
    message: string,
    input: {
      reason: ExclusiveFileLockFailure;
      lockPath: string;
      cause?: unknown;
      cleanupError?: unknown;
    }
  ) {
    super(message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "ExclusiveFileLockError";
    this.reason = input.reason;
    this.lockPath = input.lockPath;
    this.cleanupError = input.cleanupError;
  }
}

export interface ExclusiveFileLockOptions {
  timeoutMs?: number;
  retryIntervalMs?: number;
  metadata?: string | Uint8Array | (() => string | Uint8Array);
  mode?: number;
}

export const DEFAULT_EXCLUSIVE_FILE_LOCK_TIMEOUT_MS = 1_000;
export const DEFAULT_EXCLUSIVE_FILE_LOCK_RETRY_INTERVAL_MS = 25;

interface AcquiredFileLock {
  handle: number;
  identity: fs.Stats;
}

type SynchronousLockCallback<Callback extends () => unknown> =
  [Extract<ReturnType<Callback>, PromiseLike<unknown>>] extends [never]
    ? Callback
    : never;

export function withExclusiveFileLockSync<Callback extends () => unknown>(
  lockPath: string,
  callback: SynchronousLockCallback<Callback>,
  options: ExclusiveFileLockOptions = {}
): ReturnType<Callback> {
  const normalizedLockPath = path.resolve(lockPath);
  const normalized = normalizeLockOptions(normalizedLockPath, options);
  const acquired = acquireExclusiveFileLock(normalizedLockPath, normalized);
  let callbackError: unknown;

  try {
    const result = (callback as () => unknown)();
    if (isPromiseLike(result)) {
      throw new ExclusiveFileLockError(
        `Exclusive file lock callbacks must be synchronous: ${normalizedLockPath}.`,
        { reason: "invalid_callback", lockPath: normalizedLockPath }
      );
    }
    return result as ReturnType<Callback>;
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    const cleanupError = releaseOwnedFileLock(normalizedLockPath, acquired);
    if (cleanupError !== undefined) {
      throw new ExclusiveFileLockError(
        `Could not release the exclusive file lock at ${normalizedLockPath}.`,
        {
          reason: "release_failed",
          lockPath: normalizedLockPath,
          ...(callbackError === undefined ? { cause: cleanupError } : {
            cause: callbackError,
            cleanupError
          })
        }
      );
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof (value as { then?: unknown }).then === "function";
}

interface NormalizedExclusiveFileLockOptions {
  timeoutMs: number;
  retryIntervalMs: number;
  metadata?: string | Uint8Array | (() => string | Uint8Array);
  mode: number;
}

function normalizeLockOptions(
  lockPath: string,
  options: ExclusiveFileLockOptions
): NormalizedExclusiveFileLockOptions {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXCLUSIVE_FILE_LOCK_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs
    ?? DEFAULT_EXCLUSIVE_FILE_LOCK_RETRY_INTERVAL_MS;
  const mode = options.mode ?? 0o600;

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw invalidLockOptions(lockPath, "timeoutMs must be a finite non-negative number");
  }
  if (!Number.isFinite(retryIntervalMs) || retryIntervalMs <= 0) {
    throw invalidLockOptions(lockPath, "retryIntervalMs must be a finite positive number");
  }
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw invalidLockOptions(lockPath, "mode must be an integer between 0 and 0o7777");
  }

  return {
    timeoutMs,
    retryIntervalMs,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    mode
  };
}

function invalidLockOptions(lockPath: string, problem: string): ExclusiveFileLockError {
  return new ExclusiveFileLockError(`Invalid exclusive file lock options: ${problem}.`, {
    reason: "invalid_options",
    lockPath
  });
}

function acquireExclusiveFileLock(
  lockPath: string,
  options: NormalizedExclusiveFileLockOptions
): AcquiredFileLock {
  const startedAt = monotonicMilliseconds();

  while (true) {
    let handle: number;
    try {
      handle = fs.openSync(lockPath, "wx", options.mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ExclusiveFileLockError(
          `Could not acquire the exclusive file lock at ${lockPath}.`,
          { reason: "acquire_failed", lockPath, cause: error }
        );
      }

      const elapsedMs = monotonicMilliseconds() - startedAt;
      if (elapsedMs >= options.timeoutMs) {
        throw new ExclusiveFileLockError(
          `Timed out after ${options.timeoutMs}ms waiting for the exclusive file lock at ${lockPath}.`,
          { reason: "timeout", lockPath, cause: error }
        );
      }

      sleepSynchronously(Math.min(options.retryIntervalMs, options.timeoutMs - elapsedMs));
      continue;
    }

    let acquired: AcquiredFileLock;
    try {
      acquired = { handle, identity: fs.fstatSync(handle) };
    } catch (error) {
      const cleanupError = cleanupNewFileLock(lockPath, handle);
      throw new ExclusiveFileLockError(
        `Could not initialize the exclusive file lock at ${lockPath}.`,
        {
          reason: "initialize_failed",
          lockPath,
          cause: error,
          ...(cleanupError === undefined ? {} : { cleanupError })
        }
      );
    }

    try {
      if (options.metadata !== undefined) {
        const metadata = typeof options.metadata === "function"
          ? options.metadata()
          : options.metadata;
        fs.writeFileSync(handle, metadata);
        fs.fsyncSync(handle);
      }
      return acquired;
    } catch (error) {
      const cleanupError = releaseOwnedFileLock(lockPath, acquired);
      throw new ExclusiveFileLockError(
        `Could not initialize the exclusive file lock at ${lockPath}.`,
        {
          reason: "initialize_failed",
          lockPath,
          cause: error,
          ...(cleanupError === undefined ? {} : { cleanupError })
        }
      );
    }
  }
}

function cleanupNewFileLock(lockPath: string, handle: number): unknown | undefined {
  try {
    const identity = fs.fstatSync(handle);
    return releaseOwnedFileLock(lockPath, { handle, identity });
  } catch (ownershipError) {
    return closeUnverifiedFileLock(lockPath, handle, ownershipError);
  }
}

function closeUnverifiedFileLock(
  lockPath: string,
  handle: number,
  ownershipError: unknown
): unknown {
  let closeError: unknown;
  try {
    fs.closeSync(handle);
  } catch (error) {
    closeError = error;
  }

  const retainedPathError = new Error(
    `Could not verify ownership of ${lockPath}; the lock path was retained for safety.`,
    { cause: ownershipError }
  );
  return closeError === undefined
    ? retainedPathError
    : new AggregateError(
      [closeError, retainedPathError],
      `Multiple failures occurred while safely closing ${lockPath}.`
    );
}

function releaseOwnedFileLock(lockPath: string, acquired: AcquiredFileLock): unknown | undefined {
  const cleanupErrors: unknown[] = [];
  let ownershipConfirmed = false;

  try {
    const current = fs.lstatSync(lockPath);
    ownershipConfirmed = sameFileIdentity(current, acquired.identity);
    if (!ownershipConfirmed) {
      cleanupErrors.push(new Error(
        `Lock path no longer identifies the acquired lock; refusing to remove it: ${lockPath}`
      ));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cleanupErrors.push(new Error(
        `Owned lock path disappeared before it could be released: ${lockPath}`,
        { cause: error }
      ));
    } else {
      cleanupErrors.push(error);
    }
  }

  try {
    fs.closeSync(acquired.handle);
  } catch (error) {
    cleanupErrors.push(error);
    ownershipConfirmed = false;
  }

  if (ownershipConfirmed) {
    try {
      const current = fs.lstatSync(lockPath);
      if (sameFileIdentity(current, acquired.identity)) {
        fs.unlinkSync(lockPath);
      } else {
        cleanupErrors.push(new Error(
          `Lock path changed while being released; refusing to remove it: ${lockPath}`
        ));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        cleanupErrors.push(new Error(
          `Owned lock path disappeared while it was being released: ${lockPath}`,
          { cause: error }
        ));
      } else {
        cleanupErrors.push(error);
      }
    }
  }

  if (cleanupErrors.length === 0) return undefined;
  if (cleanupErrors.length === 1) return cleanupErrors[0];
  return new AggregateError(cleanupErrors, `Multiple failures occurred while releasing ${lockPath}.`);
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function monotonicMilliseconds(): number {
  return performance.now();
}

function sleepSynchronously(durationMs: number): void {
  if (durationMs <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, durationMs);
}

export type AtomicFileReplacementOperation =
  | "invalid_options"
  | "create_temporary_file"
  | "write"
  | "set_mode"
  | "flush"
  | "close_temporary_file"
  | "publish";

export class AtomicFileReplacementError extends Error {
  readonly operation: AtomicFileReplacementOperation;
  readonly targetPath: string;
  readonly temporaryPath?: string;
  readonly cleanupError?: unknown;

  constructor(
    message: string,
    input: {
      operation: AtomicFileReplacementOperation;
      targetPath: string;
      temporaryPath?: string;
      cause?: unknown;
      cleanupError?: unknown;
    }
  ) {
    super(message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "AtomicFileReplacementError";
    this.operation = input.operation;
    this.targetPath = input.targetPath;
    this.temporaryPath = input.temporaryPath;
    this.cleanupError = input.cleanupError;
  }
}

export interface AtomicFileReplacementOptions {
  mode?: number;
  encoding?: BufferEncoding;
  syncParentDirectory?: boolean;
}

const MAX_TEMPORARY_FILE_ATTEMPTS = 16;

export function replaceFileAtomicallySync(
  targetPath: string,
  data: string | Uint8Array,
  options: AtomicFileReplacementOptions = {}
): void {
  const absoluteTargetPath = path.resolve(targetPath);
  validateAtomicFileOptions(absoluteTargetPath, options);
  let temporaryPath: string | undefined;
  let handle: number | undefined;
  let operation: AtomicFileReplacementOperation = "create_temporary_file";

  try {
    ({ handle, temporaryPath } = createTemporarySiblingFile(
      absoluteTargetPath,
      options.mode ?? 0o666
    ));

    operation = "write";
    if (typeof data === "string") {
      fs.writeFileSync(handle, data, { encoding: options.encoding ?? "utf8" });
    } else {
      fs.writeFileSync(handle, data);
    }

    if (options.mode !== undefined) {
      operation = "set_mode";
      fs.fchmodSync(handle, options.mode);
    }

    operation = "flush";
    fs.fsyncSync(handle);

    operation = "close_temporary_file";
    fs.closeSync(handle);
    handle = undefined;

    operation = "publish";
    fs.renameSync(temporaryPath, absoluteTargetPath);
    temporaryPath = undefined;

    if (options.syncParentDirectory !== false) {
      syncParentDirectoryBestEffort(path.dirname(absoluteTargetPath));
    }
  } catch (error) {
    const cleanupError = cleanupTemporaryFile(handle, temporaryPath);
    throw new AtomicFileReplacementError(
      atomicFileFailureMessage(operation, absoluteTargetPath),
      {
        operation,
        targetPath: absoluteTargetPath,
        ...(temporaryPath === undefined ? {} : { temporaryPath }),
        cause: error,
        ...(cleanupError === undefined ? {} : { cleanupError })
      }
    );
  }
}

function validateAtomicFileOptions(
  targetPath: string,
  options: AtomicFileReplacementOptions
): void {
  if (
    options.mode !== undefined
    && (!Number.isInteger(options.mode) || options.mode < 0 || options.mode > 0o7777)
  ) {
    throw new AtomicFileReplacementError(
      "Invalid atomic file replacement options: mode must be an integer between 0 and 0o7777.",
      { operation: "invalid_options", targetPath }
    );
  }
}

function createTemporarySiblingFile(targetPath: string, mode: number): {
  handle: number;
  temporaryPath: string;
} {
  for (let attempt = 0; attempt < MAX_TEMPORARY_FILE_ATTEMPTS; attempt += 1) {
    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.agent-core-${crypto.randomBytes(16).toString("hex")}.tmp`
    );

    try {
      return { handle: fs.openSync(temporaryPath, "wx", mode), temporaryPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  const collisionError = new Error(
    `Could not create a unique temporary sibling after ${MAX_TEMPORARY_FILE_ATTEMPTS} attempts.`
  ) as NodeJS.ErrnoException;
  collisionError.code = "EEXIST";
  throw collisionError;
}

function cleanupTemporaryFile(
  handle: number | undefined,
  temporaryPath: string | undefined
): unknown | undefined {
  const cleanupErrors: unknown[] = [];

  if (handle !== undefined) {
    try {
      fs.closeSync(handle);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBADF") cleanupErrors.push(error);
    }
  }

  if (temporaryPath !== undefined) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length === 0) return undefined;
  if (cleanupErrors.length === 1) return cleanupErrors[0];
  return new AggregateError(cleanupErrors, `Multiple failures occurred while cleaning ${temporaryPath}.`);
}

function atomicFileFailureMessage(
  operation: AtomicFileReplacementOperation,
  targetPath: string
): string {
  const descriptions: Record<AtomicFileReplacementOperation, string> = {
    invalid_options: "validate options for",
    create_temporary_file: "create a temporary sibling for",
    write: "write the temporary file for",
    set_mode: "set the requested mode on",
    flush: "flush the temporary file for",
    close_temporary_file: "close the temporary file for",
    publish: "publish"
  };
  return `Could not ${descriptions[operation]} ${targetPath} atomically.`;
}

function syncParentDirectoryBestEffort(directoryPath: string): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(directoryPath, fs.constants.O_RDONLY);
    fs.fsyncSync(handle);
  } catch {
    // Directory handles and directory fsync are not portable across supported runtimes.
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Publication has already succeeded; best-effort durability must not report a false rollback.
      }
    }
  }
}
