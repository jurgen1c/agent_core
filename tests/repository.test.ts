import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findGitRepositoryRoot,
  isPathInside,
  nearestExistingAncestor,
  PathContainmentError,
  resolveContainedPath
} from "../src/repository";

describe("repository discovery", () => {
  test("finds a parent Git directory", () => {
    const root = temporaryDirectory("agent-core-git-");
    const nested = path.join(root, "src", "nested");
    initializeGitRepository(root);
    fs.mkdirSync(nested, { recursive: true });

    expect(findGitRepositoryRoot(nested)).toBe(root);
  });

  test("searches from a symlink target instead of the link parent", () => {
    const root = temporaryDirectory("agent-core-symlink-git-");
    const nested = path.join(root, "nested");
    const linkParent = temporaryDirectory("agent-core-symlink-parent-");
    const link = path.join(linkParent, "linked-repository");
    initializeGitRepository(root);
    fs.mkdirSync(nested);
    fs.symlinkSync(nested, link, "dir");

    expect(findGitRepositoryRoot(link)).toBe(root);
  });

  test("returns null when no Git root exists", () => {
    const root = temporaryDirectory("agent-core-no-git-");
    expect(findGitRepositoryRoot(root, { stopAt: root })).toBeNull();
  });
});

describe("path containment", () => {
  test("handles equal, child, and sibling paths", () => {
    const root = path.resolve(os.tmpdir(), "agent-core-root");

    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, path.join(root, "src/index.ts"))).toBe(true);
    expect(isPathInside(root, `${root}-sibling/index.ts`)).toBe(false);
  });

  test("finds the nearest existing ancestor", () => {
    const root = temporaryDirectory("agent-core-ancestor-");
    expect(nearestExistingAncestor(path.join(root, "missing", "file.txt"))).toBe(root);
  });

  test("resolves missing descendants inside a root", () => {
    const root = temporaryDirectory("agent-core-contained-");
    const result = resolveContainedPath(root, "runs/new/artifact.json");

    expect(result.absolutePath).toBe(path.join(root, "runs/new/artifact.json"));
    expect(result.existingAncestorPath).toBe(root);
    expect(result.realRootPath).toBe(fs.realpathSync(root));
  });

  test("rejects lexical traversal", () => {
    const root = temporaryDirectory("agent-core-contained-");

    expect(() => resolveContainedPath(root, "../outside.txt")).toThrow(
      new PathContainmentError("Path escapes its containment root: ../outside.txt", {
        reason: "lexical_escape",
        rootPath: root,
        candidatePath: path.resolve(root, "../outside.txt")
      })
    );
  });

  test("rejects symlink escapes", () => {
    const root = temporaryDirectory("agent-core-contained-");
    const outside = temporaryDirectory("agent-core-outside-");
    fs.symlinkSync(outside, path.join(root, "external"), "dir");

    try {
      resolveContainedPath(root, "external/artifact.json");
      throw new Error("Expected path containment to reject the symlink escape.");
    } catch (error) {
      expect(error).toBeInstanceOf(PathContainmentError);
      expect((error as PathContainmentError).reason).toBe("symlink_escape");
    }
  });

  test("allows contained symlinks unless the final path is forbidden", () => {
    const root = temporaryDirectory("agent-core-contained-");
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, "dir");

    expect(resolveContainedPath(root, "link").realExistingAncestorPath).toBe(target);
    expect(() =>
      resolveContainedPath(root, "link", { rejectFinalSymlink: true })
    ).toThrow("Path cannot be a symbolic link");
  });

  test("rejects missing containment roots", () => {
    const root = path.join(temporaryDirectory("agent-core-missing-"), "missing");

    try {
      resolveContainedPath(root, "artifact.json");
      throw new Error("Expected a missing root error.");
    } catch (error) {
      expect(error).toBeInstanceOf(PathContainmentError);
      expect((error as PathContainmentError).reason).toBe("root_missing");
    }
  });
});

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initializeGitRepository(root: string): void {
  execFileSync("git", ["init", "--quiet"], {
    cwd: root,
    stdio: "ignore"
  });
}
