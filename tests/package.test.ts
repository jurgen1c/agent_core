import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

describe("public package contract", () => {
  test("publishes one dependency-light library with explicit subpaths", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")
    ) as {
      name: string;
      version: string;
      bin?: unknown;
      dependencies?: Record<string, string>;
      engines?: { node?: string };
      exports?: Record<string, unknown>;
      publishConfig?: { access?: string };
    };

    expect(packageJson.name).toBe("@jurgen1c/agent-core");
    expect(packageJson.version).toBe("0.1.0");
    expect(packageJson.bin).toBeUndefined();
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.engines?.node).toBe(">=25.9.0");
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "is-path-inside",
      "yaml"
    ]);
    expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual([
      ".",
      "./repository",
      "./sqlite",
      "./yaml"
    ]);

    const forbiddenProductDependencies = Object.keys(packageJson.dependencies ?? {}).filter(
      (dependency) =>
        /^@jurgen1c\/(?:agent-memory|agent-flow|agentic-development)(?:$|-)/.test(dependency)
    );
    expect(forbiddenProductDependencies).toEqual([]);
  });

  test("has no product-layer imports", () => {
    const sourceRoot = path.join(import.meta.dir, "..", "src");
    const source = fs.readdirSync(sourceRoot)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => fs.readFileSync(path.join(sourceRoot, file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(
      /(?:from|import)\s*\(?\s*["']@jurgen1c\/(?:agent-memory|agent-flow|agentic-development)/
    );
  });
});
