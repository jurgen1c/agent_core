import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AtomicFileReplacementError,
  ExclusiveFileLockError,
  inspectFileSystemPathSync,
  replaceFileAtomicallySync,
  withExclusiveFileLockSync
} from "../src/filesystem";

afterEach(() => {
  // Restore any filesystem failure injected by the preceding test.
  // Bun restores each spy independently and tolerates an already-restored mock.
  for (const method of [
    "lstatSync",
    "openSync",
    "writeFileSync",
    "fchmodSync",
    "fsyncSync",
    "closeSync",
    "renameSync"
  ] as const) {
    const candidate = fs[method] as unknown as { mockRestore?: () => void };
    candidate.mockRestore?.();
  }
});

describe("filesystem path inspection", () => {
  test("distinguishes present, ENOENT, and ENOTDIR paths", () => {
    const root = temporaryDirectory("agent-core-inspect-");
    const present = path.join(root, "present.txt");
    fs.writeFileSync(present, "present");

    const presentInspection = inspectFileSystemPathSync(present);
    expect(presentInspection.status).toBe("present");
    if (presentInspection.status === "present") {
      expect(presentInspection.stats.isFile()).toBe(true);
    }

    expect(inspectFileSystemPathSync(path.join(root, "missing")).status).toBe("missing");
    expect(inspectFileSystemPathSync(path.join(present, "child")).status).toBe("missing");
  });

  test("treats a dangling symbolic link as present", () => {
    const root = temporaryDirectory("agent-core-inspect-link-");
    const link = path.join(root, "dangling");
    fs.symlinkSync(path.join(root, "missing"), link);

    const inspection = inspectFileSystemPathSync(link);
    expect(inspection.status).toBe("present");
    if (inspection.status === "present") {
      expect(inspection.stats.isSymbolicLink()).toBe(true);
    }
  });

  test("retains permission and I/O errors as inconclusive", () => {
    for (const code of ["EACCES", "EIO"]) {
      const injected = Object.assign(new Error(`injected ${code}`), { code });
      const lstat = spyOn(fs, "lstatSync").mockImplementation(() => {
        throw injected;
      });

      const inspection = inspectFileSystemPathSync("/inaccessible");
      expect(inspection.status).toBe("inconclusive");
      if (inspection.status === "inconclusive") {
        expect(inspection.error).toBe(injected);
      }
      lstat.mockRestore();
    }
  });

  test("reports a real inaccessible nested path as inconclusive when permissions apply", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;

    const root = temporaryDirectory("agent-core-inaccessible-");
    const privateDirectory = path.join(root, "private");
    fs.mkdirSync(privateDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(privateDirectory, "value"), "secret");
    fs.chmodSync(privateDirectory, 0o000);

    try {
      expect(inspectFileSystemPathSync(path.join(privateDirectory, "value")).status)
        .toBe("inconclusive");
    } finally {
      fs.chmodSync(privateDirectory, 0o700);
    }
  });
});

describe("exclusive file locks", () => {
  test("acquires, initializes, returns the callback value, and releases", () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-"), "work.lock");
    const metadata = () => `owner=${process.pid}\n`;

    const result = withExclusiveFileLockSync(lockPath, () => {
      expect(fs.readFileSync(lockPath, "utf8")).toBe(`owner=${process.pid}\n`);
      return "completed";
    }, { metadata });

    expect(result).toBe("completed");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("rejects Promise-returning callbacks at the type and runtime boundaries", async () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-async-"), "work.lock");
    let continuedAfterAwait = false;
    const asyncCallback = async () => {
      await Promise.resolve();
      continuedAfterAwait = true;
      return "completed";
    };

    try {
      withExclusiveFileLockSync(
        lockPath,
        asyncCallback as unknown as () => string
      );
      throw new Error("Expected the synchronous lock to reject a Promise result.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExclusiveFileLockError);
      expect((error as ExclusiveFileLockError).reason).toBe("invalid_callback");
    }

    expect(fs.existsSync(lockPath)).toBe(false);
    await Promise.resolve();
    expect(continuedAfterAwait).toBe(true);

    if (false) {
      // @ts-expect-error Promise-returning callbacks are excluded from the synchronous API.
      withExclusiveFileLockSync(lockPath, asyncCallback);

      const maybeAsyncCallback: () => string | Promise<string> = () => "completed";
      // @ts-expect-error Any Promise-like member makes the callback asynchronous.
      withExclusiveFileLockSync(lockPath, maybeAsyncCallback);
    }
  });

  test("times out without removing or changing an existing lock", () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-held-"), "work.lock");
    fs.writeFileSync(lockPath, "existing-owner\n");
    const before = fs.statSync(lockPath);

    try {
      withExclusiveFileLockSync(lockPath, () => undefined, { timeoutMs: 0 });
      throw new Error("Expected lock contention to time out.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExclusiveFileLockError);
      expect((error as ExclusiveFileLockError).reason).toBe("timeout");
    }

    const after = fs.statSync(lockPath);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("existing-owner\n");
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  });

  test("retries bounded contention before timing out", () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-retry-"), "work.lock");
    fs.writeFileSync(lockPath, "existing-owner\n");
    const originalOpen = fs.openSync.bind(fs);
    let attempts = 0;
    spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
      if (filePath === lockPath && flags === "wx") attempts += 1;
      return originalOpen(filePath, flags, mode);
    }) as typeof fs.openSync);

    try {
      withExclusiveFileLockSync(lockPath, () => undefined, {
        timeoutMs: 5,
        retryIntervalMs: 1
      });
      throw new Error("Expected lock contention to time out.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExclusiveFileLockError);
      expect((error as ExclusiveFileLockError).reason).toBe("timeout");
    }

    expect(attempts).toBeGreaterThan(1);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("existing-owner\n");
  });

  test("cleans up when metadata production fails", () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-metadata-"), "work.lock");
    const failure = new Error("metadata failed");

    try {
      withExclusiveFileLockSync(lockPath, () => undefined, {
        metadata: () => {
          throw failure;
        }
      });
      throw new Error("Expected metadata initialization to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExclusiveFileLockError);
      expect((error as ExclusiveFileLockError).reason).toBe("initialize_failed");
      expect(error).toHaveProperty("cause", failure);
    }

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("cleans up when metadata writing fails", () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-write-"), "work.lock");
    const failure = new Error("write failed");
    spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw failure;
    });

    try {
      withExclusiveFileLockSync(lockPath, () => undefined, { metadata: "owner" });
      throw new Error("Expected metadata writing to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExclusiveFileLockError);
      expect((error as ExclusiveFileLockError).reason).toBe("initialize_failed");
      expect((error as ExclusiveFileLockError).cause).toBe(failure);
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("cleans up when metadata flushing fails", () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-flush-"), "work.lock");
    const failure = new Error("flush failed");
    spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw failure;
    });

    try {
      withExclusiveFileLockSync(lockPath, () => undefined, { metadata: "owner" });
      throw new Error("Expected metadata flushing to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExclusiveFileLockError);
      expect((error as ExclusiveFileLockError).reason).toBe("initialize_failed");
      expect((error as ExclusiveFileLockError).cause).toBe(failure);
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("cleans up and preserves a callback failure", () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-callback-"), "work.lock");
    const failure = new Error("protected operation failed");
    let caught: unknown;

    try {
      withExclusiveFileLockSync(lockPath, () => {
        throw failure;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("refuses to remove a replacement lock created while the callback runs", () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-replaced-"), "work.lock");

    try {
      withExclusiveFileLockSync(lockPath, () => {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, "replacement-owner\n");
      });
      throw new Error("Expected replacement ownership to make release fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExclusiveFileLockError);
      expect((error as ExclusiveFileLockError).reason).toBe("release_failed");
    }

    expect(fs.readFileSync(lockPath, "utf8")).toBe("replacement-owner\n");
  });

  test("reports an owned lock removed during the callback as a release failure", () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-missing-"), "work.lock");

    try {
      withExclusiveFileLockSync(lockPath, () => {
        fs.unlinkSync(lockPath);
      });
      throw new Error("Expected missing lock ownership to make release fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExclusiveFileLockError);
      expect((error as ExclusiveFileLockError).reason).toBe("release_failed");
      expect((error as ExclusiveFileLockError).cause).toHaveProperty(
        "message",
        expect.stringContaining("disappeared")
      );
    }

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("reports disappearance between release identity checks", () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-release-race-"), "work.lock");
    const originalLstat = fs.lstatSync.bind(fs);
    let lockInspections = 0;
    spyOn(fs, "lstatSync").mockImplementation(((filePath, options) => {
      if (filePath === lockPath) {
        lockInspections += 1;
        if (lockInspections === 2) fs.unlinkSync(lockPath);
      }
      return originalLstat(filePath, options as never);
    }) as typeof fs.lstatSync);

    try {
      withExclusiveFileLockSync(lockPath, () => undefined);
      throw new Error("Expected release-time disappearance to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExclusiveFileLockError);
      expect((error as ExclusiveFileLockError).reason).toBe("release_failed");
      expect((error as ExclusiveFileLockError).cause).toHaveProperty(
        "message",
        expect.stringContaining("disappeared")
      );
    }

    expect(lockInspections).toBe(2);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("distinguishes acquisition failures from contention", () => {
    const lockPath = path.join(temporaryDirectory("agent-core-lock-parent-"), "missing", "work.lock");

    try {
      withExclusiveFileLockSync(lockPath, () => undefined);
      throw new Error("Expected lock acquisition to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExclusiveFileLockError);
      expect((error as ExclusiveFileLockError).reason).toBe("acquire_failed");
      expect((error as ExclusiveFileLockError).cause).toHaveProperty("code", "ENOENT");
    }
  });
});

describe("atomic file replacement", () => {
  test("writes strings and bytes, overwrites atomically, and enforces an explicit mode", () => {
    const root = temporaryDirectory("agent-core-atomic-");
    const target = path.join(root, "value.txt");

    replaceFileAtomicallySync(target, "first", { mode: 0o640 });
    expect(fs.readFileSync(target, "utf8")).toBe("first");
    if (process.platform !== "win32") {
      expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    }

    replaceFileAtomicallySync(target, new TextEncoder().encode("second"), { mode: 0o600 });
    expect(fs.readFileSync(target, "utf8")).toBe("second");
    expect(temporarySiblings(root)).toEqual([]);
  });

  test("retries a temporary-name collision without touching the colliding file", () => {
    const root = temporaryDirectory("agent-core-atomic-collision-");
    const target = path.join(root, "value.txt");
    const collision = path.join(root, ".value.txt.collision.tmp");
    fs.writeFileSync(collision, "do not remove");
    const originalOpen = fs.openSync.bind(fs);
    let injected = false;

    spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
      if (!injected && flags === "wx") {
        injected = true;
        const error = Object.assign(new Error("collision"), { code: "EEXIST" });
        throw error;
      }
      return originalOpen(filePath, flags, mode);
    }) as typeof fs.openSync);

    replaceFileAtomicallySync(target, "published", { syncParentDirectory: false });
    expect(fs.readFileSync(target, "utf8")).toBe("published");
    expect(fs.readFileSync(collision, "utf8")).toBe("do not remove");
    expect(temporarySiblings(root)).toEqual([collision]);
  });

  for (const failureCase of [
    { operation: "write", method: "writeFileSync" },
    { operation: "set_mode", method: "fchmodSync" },
    { operation: "flush", method: "fsyncSync" },
    { operation: "publish", method: "renameSync" }
  ] as const) {
    test(`preserves the published file and cleans the temporary file on ${failureCase.operation} failure`, () => {
      const root = temporaryDirectory(`agent-core-atomic-${failureCase.operation}-`);
      const target = path.join(root, "value.txt");
      fs.writeFileSync(target, "old");
      const failure = new Error(`${failureCase.operation} failed`);
      spyOn(fs, failureCase.method).mockImplementation((() => {
        throw failure;
      }) as never);

      try {
        replaceFileAtomicallySync(target, "new", {
          mode: 0o600,
          syncParentDirectory: false
        });
        throw new Error("Expected atomic replacement to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(AtomicFileReplacementError);
        expect((error as AtomicFileReplacementError).operation).toBe(failureCase.operation);
        expect((error as AtomicFileReplacementError).cause).toBe(failure);
      }

      expect(fs.readFileSync(target, "utf8")).toBe("old");
      expect(temporarySiblings(root)).toEqual([]);
    });
  }

  test("preserves the published file and cleans the temporary file on close failure", () => {
    const root = temporaryDirectory("agent-core-atomic-close-");
    const target = path.join(root, "value.txt");
    fs.writeFileSync(target, "old");
    const originalClose = fs.closeSync.bind(fs);
    const failure = new Error("close failed");
    let injected = false;

    spyOn(fs, "closeSync").mockImplementation((handle) => {
      if (!injected) {
        injected = true;
        originalClose(handle);
        throw failure;
      }
      originalClose(handle);
    });

    try {
      replaceFileAtomicallySync(target, "new", { syncParentDirectory: false });
      throw new Error("Expected atomic replacement to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicFileReplacementError);
      expect((error as AtomicFileReplacementError).operation).toBe("close_temporary_file");
      expect((error as AtomicFileReplacementError).cause).toBe(failure);
      expect((error as AtomicFileReplacementError).cleanupError).toBeUndefined();
    }

    expect(fs.readFileSync(target, "utf8")).toBe("old");
    expect(temporarySiblings(root)).toEqual([]);
  });

  test("treats parent-directory flush as best-effort after publication", () => {
    const root = temporaryDirectory("agent-core-atomic-parent-flush-");
    const target = path.join(root, "value.txt");
    const originalOpen = fs.openSync.bind(fs);

    spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
      if (path.resolve(String(filePath)) === root && flags === fs.constants.O_RDONLY) {
        throw Object.assign(new Error("directory handles unsupported"), { code: "EISDIR" });
      }
      return originalOpen(filePath, flags, mode);
    }) as typeof fs.openSync);

    replaceFileAtomicallySync(target, "published");
    expect(fs.readFileSync(target, "utf8")).toBe("published");
    expect(temporarySiblings(root)).toEqual([]);
  });
});

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function temporarySiblings(directory: string): string[] {
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".tmp"))
    .map((name) => path.join(directory, name))
    .sort();
}
