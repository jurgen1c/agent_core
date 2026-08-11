# Agent Core

`@jurgen1c/agent-core` contains shared, product-neutral runtime primitives used
by Agent Memory and Agent Flow.

It intentionally does not contain memory claims, workflow execution, CLI
routing, user interfaces, product schemas, release coordination, or the
Agent Memory and Agent Flow integration adapter.

## Install

```bash
npm install @jurgen1c/agent-core
```

Node.js 25.9.0 or newer is required. Bun is supported as the development and test
runtime.

## Public APIs

### Filesystem inspection, locks, and atomic replacement

```ts
import {
  inspectFileSystemPathSync,
  replaceFileAtomicallySync,
  withExclusiveFileLockSync
} from "@jurgen1c/agent-core/filesystem";

const inspection = inspectFileSystemPathSync(".agent-data/state.json");
if (inspection.status === "inconclusive") throw inspection.error;

withExclusiveFileLockSync(".agent-data/state.lock", () => {
  const serialized = `${JSON.stringify({ ready: true }, null, 2)}\n`;
  replaceFileAtomicallySync(".agent-data/state.json", serialized, { mode: 0o600 });
}, {
  timeoutMs: 1_000,
  retryIntervalMs: 25,
  metadata: () => `pid=${process.pid}\n`
});
```

`inspectFileSystemPathSync` returns `present`, `missing`, or `inconclusive`.
Only `ENOENT` and `ENOTDIR` are missing; permission, storage, and other I/O
errors remain available on the inconclusive result. Inspection uses `lstat`, so
a dangling symbolic link is present.

`withExclusiveFileLockSync` creates a lock with exclusive `wx` semantics and
waits for at most the configured timeout. It never breaks an existing lock.
Caller metadata may be bytes, a string, or a factory evaluated after acquisition.
The protected callback must be synchronous; return types containing any
Promise-like member are rejected at the type boundary, and Promise-like results
fail with `invalid_callback` when encountered at runtime.
`ExclusiveFileLockError` exposes a product-neutral `reason`, `lockPath`, and
underlying `cause` so consumers can provide their own messages. The owned lock
is released when metadata initialization or the protected callback fails. Core
checks the lock's filesystem identity before removal and retains the path with a
`release_failed` error if ownership cannot be proven; cooperating callers must
not unlink or replace an active pathname-based lock. Disappearance of the owned
lock path is also reported as `release_failed` because mutual exclusion can no
longer be guaranteed.

`replaceFileAtomicallySync` accepts strings or bytes. It exclusively creates a
random temporary sibling, writes it, applies an explicitly requested mode,
flushes and closes it, then renames it over the target. Pre-publication failures
leave the previous target in place and remove the temporary file.
`AtomicFileReplacementError` identifies the failed operation and retains the
cause. Core attempts to flush the parent directory after publication, but treats
that as best effort because directory handles and directory `fsync` are not
portable across Node and Bun platforms. Cleanup ignores `EBADF` from a repeated
close because that descriptor is already closed, while retaining other cleanup
errors.

### Strict YAML data parsing

```ts
import { parseYamlDocumentOrThrow } from "@jurgen1c/agent-core/yaml";

const value = parseYamlDocumentOrThrow("enabled: true\n");
```

YAML is parsed with the maintained `yaml` package in strict core-schema mode.
The result is normalized to JSON-compatible values. Duplicate keys, unsafe
numbers, circular aliases, unsupported values, and parser warnings fail closed.

### SQLite portability

```ts
import {
  openSqliteDatabase,
  sqliteArtifactPaths
} from "@jurgen1c/agent-core/sqlite";

const database = await openSqliteDatabase(".agent-data/data.sqlite");
database.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)");
database.close();

for (const artifactPath of sqliteArtifactPaths(".agent-data/data.sqlite")) {
  console.log(artifactPath);
}
```

The adapter uses `bun:sqlite` under Bun and `node:sqlite` under Node. It keeps
the public query contract consistent without adding a native SQLite addon to
consumer installs. `sqliteArtifactPaths` returns the deterministic ordered set
of the main database, `-journal`, `-wal`, and `-shm` paths without inspecting or
changing the filesystem.

### Repository and path safety

```ts
import {
  findGitRepositoryRoot,
  resolveContainedPath
} from "@jurgen1c/agent-core/repository";

const root = findGitRepositoryRoot();
if (root) {
  const artifact = resolveContainedPath(root, "artifacts/result.json");
  console.log(artifact.absolutePath);

  // Opt in when even in-root symbolic-link components are forbidden.
  resolveContainedPath(root, "private/result.json", {
    rejectSymlinkComponents: true
  });
}
```

Repository discovery uses `find-up`. Lexical containment uses
`is-path-inside`, then Core adds realpath and symlink checks because lexical
checks alone are not a filesystem security boundary. Callers can pass
`{ stopAt }` to repository discovery when searches must remain inside a known
workspace boundary.

`resolveContainedPath` keeps its existing behavior by default: contained
symbolic links are allowed and symlink escapes are rejected. Set
`rejectFinalSymlink` to reject only an existing final link, or
`rejectSymlinkComponents` to reject the containment root or any existing final
or intermediate link, including links whose targets remain inside the root.

## Agent Memory consumer migration guide

Serialization and product error wording stay in Agent Memory. The intended
migrations are:

- Registry locking: wrap the registry read/update/write transaction with
  `withExclusiveFileLockSync`; pass the current timeout/retry values, mode
  `0o600`, and serialized PID/acquisition-time metadata. Translate
  `ExclusiveFileLockError` into `RegistryError` at the product boundary.
- Registry atomic writes: serialize and validate registry JSON in Agent Memory,
  then call `replaceFileAtomicallySync(registryPath, json, { mode: 0o600 })`.
- Plan-run atomic writes: retain plan YAML rendering and the immediate-contention
  policy in Agent Memory; use `timeoutMs: 0` for its lock and publish the YAML
  with `replaceFileAtomicallySync`.
- UI-model atomic writes: retain YAML patching/rendering in Agent Memory and
  publish the resulting string with `replaceFileAtomicallySync`.
- SQLite artifacts: replace local main/`-journal`/`-wal`/`-shm` arrays with
  `sqliteArtifactPaths` in registry inspection and compiler cleanup.

Some behavior cannot migrate without changing semantics. The compiler's backup,
sidecar cleanup, restoration, and choice of which prepared database wins are a
database publication policy, not a byte-write primitive. Registry maintenance's
generated-directory allowlists, active/stale/inconclusive checkout policy,
prune eligibility, staging, rollback, `prune_pending` reconciliation, and any
original-versus-staged choice also remain in Agent Memory. Existing two-state
or boolean consumer results cannot expose Core's inconclusive inspection state
without an Agent Memory API change. Core deliberately provides no staged-
directory transaction manager or registry schema knowledge.

## Dependency Policy

Core owns third-party runtime dependencies only when both products consume
them through a supported Core API. Consumers must not import Core's transitive
dependencies directly.

Product-specific and development-only dependencies stay in their owning
repositories. In particular:

- Agent Memory owns React, XYFlow, Markdown rendering, and UI build tools.
- Agent Flow owns workflow schemas, policies, execution, and lifecycle logic.
- Each repository declares its own TypeScript, ESLint, test, and type packages.
- The Memory and Flow integration adapter belongs to Agentic Development.

## Development

```bash
bun install
bun run ci
bun run verify:package
```
