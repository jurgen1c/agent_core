import fs from "node:fs";
import path from "node:path";
import { findUpSync } from "find-up";
import isPathInsideDependency from "is-path-inside";

export type PathContainmentFailure =
  | "root_missing"
  | "lexical_escape"
  | "symlink_escape"
  | "final_symlink";

export class PathContainmentError extends Error {
  readonly reason: PathContainmentFailure;
  readonly rootPath: string;
  readonly candidatePath: string;

  constructor(
    message: string,
    input: {
      reason: PathContainmentFailure;
      rootPath: string;
      candidatePath: string;
    }
  ) {
    super(message);
    this.name = "PathContainmentError";
    this.reason = input.reason;
    this.rootPath = input.rootPath;
    this.candidatePath = input.candidatePath;
  }
}

export interface ResolveContainedPathOptions {
  rejectFinalSymlink?: boolean;
}

export interface FindGitRepositoryRootOptions {
  stopAt?: string;
}

export interface ResolvedContainedPath {
  absolutePath: string;
  existingAncestorPath: string;
  realExistingAncestorPath: string;
  realRootPath: string;
}

export function findGitRepositoryRoot(
  start = process.cwd(),
  options: FindGitRepositoryRootOptions = {}
): string | null {
  const ancestor = nearestExistingAncestor(start);
  if (ancestor === null) return null;

  const cwd = fs.statSync(ancestor).isDirectory() ? ancestor : path.dirname(ancestor);
  const gitEntry = findUpSync(".git", {
    cwd,
    type: "both",
    allowSymlinks: false,
    ...(options.stopAt === undefined
      ? {}
      : { stopAt: path.resolve(options.stopAt) })
  });

  return gitEntry === undefined ? null : fs.realpathSync(path.dirname(gitEntry));
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  return child === parent || isPathInsideDependency(child, parent);
}

export function nearestExistingAncestor(targetPath: string): string | null {
  let candidate = path.resolve(targetPath);

  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }

  return candidate;
}

export function resolveContainedPath(
  rootPath: string,
  candidatePath: string,
  options: ResolveContainedPathOptions = {}
): ResolvedContainedPath {
  const absoluteRootPath = path.resolve(rootPath);

  if (!fs.existsSync(absoluteRootPath)) {
    throw new PathContainmentError(`Containment root does not exist: ${absoluteRootPath}`, {
      reason: "root_missing",
      rootPath: absoluteRootPath,
      candidatePath
    });
  }

  const realRootPath = fs.realpathSync(absoluteRootPath);
  const absolutePath = path.isAbsolute(candidatePath)
    ? path.normalize(candidatePath)
    : path.resolve(absoluteRootPath, candidatePath);

  if (!isPathInside(absoluteRootPath, absolutePath)) {
    throw new PathContainmentError(`Path escapes its containment root: ${candidatePath}`, {
      reason: "lexical_escape",
      rootPath: absoluteRootPath,
      candidatePath: absolutePath
    });
  }

  if (options.rejectFinalSymlink === true && isSymbolicLink(absolutePath)) {
    throw new PathContainmentError(`Path cannot be a symbolic link: ${candidatePath}`, {
      reason: "final_symlink",
      rootPath: absoluteRootPath,
      candidatePath: absolutePath
    });
  }

  const existingAncestorPath = nearestExistingAncestor(absolutePath);

  if (existingAncestorPath === null) {
    throw new PathContainmentError(`Path has no existing ancestor: ${candidatePath}`, {
      reason: "root_missing",
      rootPath: absoluteRootPath,
      candidatePath: absolutePath
    });
  }

  const realExistingAncestorPath = fs.realpathSync(existingAncestorPath);

  if (!isPathInside(realRootPath, realExistingAncestorPath)) {
    throw new PathContainmentError(
      `Path escapes its containment root through a symbolic link: ${candidatePath}`,
      {
        reason: "symlink_escape",
        rootPath: absoluteRootPath,
        candidatePath: absolutePath
      }
    );
  }

  return {
    absolutePath,
    existingAncestorPath,
    realExistingAncestorPath,
    realRootPath
  };
}

function isSymbolicLink(candidate: string): boolean {
  try {
    return fs.lstatSync(candidate).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
