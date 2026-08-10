#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-core-package-"));

try {
  run("bun", ["run", "build"]);
  const dryRun = run("npm", [
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temporaryRoot
  ]);
  const manifest = parsePackOutput(dryRun)[0];
  const files = manifest.files.map((entry) => entry.path);

  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/filesystem.js",
    "dist/filesystem.d.ts",
    "dist/repository.js",
    "dist/repository.d.ts",
    "dist/sqlite.js",
    "dist/sqlite.d.ts",
    "dist/yaml.js",
    "dist/yaml.d.ts"
  ]) {
    if (!files.includes(required)) {
      fail(`Packed artifact is missing ${required}.`);
    }
  }

  const forbidden = files.filter((file) =>
    /(^|\/)(?:src|tests?|fixtures?|coverage|node_modules|\.git)(?:\/|$)/i.test(file)
    || /(^|\/)\.env(?:\.|$)/i.test(file)
    || /\.(?:sqlite|db|pem|key|log)$/i.test(file)
  );

  if (forbidden.length > 0) {
    fail(`Packed artifact contains forbidden files:\n${forbidden.join("\n")}`);
  }

  const packed = parsePackOutput(
    run("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      temporaryRoot
    ])
  )[0];
  const tarballPath = path.join(temporaryRoot, packed.filename);
  const consumerRoot = path.join(temporaryRoot, "consumer");
  fs.mkdirSync(consumerRoot);
  fs.writeFileSync(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(consumerRoot, "smoke.mjs"),
    `import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@jurgen1c/agent-core";
import {
  inspectFileSystemPathSync,
  replaceFileAtomicallySync,
  withExclusiveFileLockSync
} from "@jurgen1c/agent-core/filesystem";
import { resolveContainedPath } from "@jurgen1c/agent-core/repository";
import { openSqliteDatabase, sqliteArtifactPaths } from "@jurgen1c/agent-core/sqlite";
import { parseYamlDocumentOrThrow } from "@jurgen1c/agent-core/yaml";

if (typeof core.findGitRepositoryRoot !== "function") {
  throw new Error("Root export is missing findGitRepositoryRoot.");
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-core-smoke-"));
const resolved = resolveContainedPath(root, "artifacts/result.json");
if (resolved.absolutePath !== path.join(root, "artifacts/result.json")) {
  throw new Error("Repository subpath smoke test failed.");
}
const atomicPath = path.join(root, "atomic.txt");
replaceFileAtomicallySync(atomicPath, "ready", { mode: 0o600 });
if (inspectFileSystemPathSync(atomicPath).status !== "present") {
  throw new Error("Filesystem subpath inspection smoke test failed.");
}
const lockPath = path.join(root, "smoke.lock");
withExclusiveFileLockSync(lockPath, () => {
  if (!fs.existsSync(lockPath)) throw new Error("Filesystem lock smoke test failed.");
}, { metadata: "smoke" });
if (fs.existsSync(lockPath)) throw new Error("Filesystem lock release smoke test failed.");
const yaml = parseYamlDocumentOrThrow("enabled: true\\n");
if (yaml.enabled !== true) throw new Error("YAML subpath smoke test failed.");
const database = await openSqliteDatabase(path.join(root, "smoke.sqlite"));
database.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
database.run("INSERT INTO smoke (value) VALUES (?)", ["ready"]);
if (database.get("SELECT value FROM smoke")?.value !== "ready") {
  throw new Error("SQLite subpath smoke test failed.");
}
database.close();
const artifacts = sqliteArtifactPaths(path.join(root, "smoke.sqlite"));
if (artifacts[3] !== path.join(root, "smoke.sqlite-shm")) {
  throw new Error("SQLite artifact path smoke test failed.");
}
console.log("Agent Core tarball smoke test passed.");
`
  );

  run("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    tarballPath
  ], consumerRoot);
  run(process.execPath, ["smoke.mjs"], consumerRoot);

  console.log(
    `Verified ${manifest.name}@${manifest.version}: ${files.length} packed files and a clean consumer install.`
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: path.join(temporaryRoot, "npm-cache")
    }
  });

  if (result.error || result.status !== 0) {
    if (result.error) {
      console.error(`${command} failed to start: ${result.error.message}`);
    }
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.error ? 1 : result.status ?? 1);
  }

  return result.stdout.length > 0 ? result.stdout : result.stderr;
}

function parsePackOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    fail(`Could not parse npm pack output:\n${output}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
