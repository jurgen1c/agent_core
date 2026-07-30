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
import { openSqliteDatabase } from "@jurgen1c/agent-core/sqlite";

const database = await openSqliteDatabase(".agent-data/data.sqlite");
database.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)");
database.close();
```

The adapter uses `bun:sqlite` under Bun and `node:sqlite` under Node. It keeps
the public query contract consistent without adding a native SQLite addon to
consumer installs.

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
}
```

Repository discovery uses `find-up`. Lexical containment uses
`is-path-inside`, then Core adds realpath and symlink checks because lexical
checks alone are not a filesystem security boundary. Callers can pass
`{ stopAt }` to repository discovery when searches must remain inside a known
workspace boundary.

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
