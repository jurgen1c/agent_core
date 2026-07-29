import { parseDocument, type YAMLError } from "yaml";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface YamlParseIssue {
  code: "yaml.syntax" | "yaml.value";
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

export type YamlParseResult =
  | { ok: true; value: JsonValue }
  | { ok: false; issues: YamlParseIssue[] };

export interface ParseYamlDocumentOptions {
  maxAliasCount?: number;
}

export class YamlDocumentError extends Error {
  readonly issues: YamlParseIssue[];

  constructor(issues: YamlParseIssue[]) {
    super(formatYamlParseIssues(issues));
    this.name = "YamlDocumentError";
    this.issues = issues;
  }
}

export function parseYamlDocument(
  source: string,
  options: ParseYamlDocumentOptions = {}
): YamlParseResult {
  const maxAliasCount = normalizedAliasCount(options.maxAliasCount);
  const document = parseDocument(source, {
    logLevel: "error",
    prettyErrors: true,
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true
  });
  const diagnostics = [...document.errors, ...document.warnings];

  if (diagnostics.length > 0) {
    return {
      ok: false,
      issues: diagnostics.map(issueFromYamlError)
    };
  }

  try {
    return {
      ok: true,
      value: normalizeJsonValue(
        document.toJS({ maxAliasCount }),
        "$",
        new Set()
      )
    };
  } catch (error) {
    return {
      ok: false,
      issues: [issueFromValueError(error)]
    };
  }
}

export function parseYamlDocumentOrThrow(
  source: string,
  options: ParseYamlDocumentOptions = {}
): JsonValue {
  const result = parseYamlDocument(source, options);
  if (result.ok) return result.value;
  throw new YamlDocumentError(result.issues);
}

export function formatYamlParseIssues(issues: readonly YamlParseIssue[]): string {
  return issues
    .map((issue) => {
      const location =
        issue.line === undefined
          ? ""
          : ` at line ${issue.line}${issue.column === undefined ? "" : `, column ${issue.column}`}`;
      const issuePath = issue.path === undefined ? "" : ` (${issue.path})`;
      return `${issue.code}${location}${issuePath}: ${issue.message}`;
    })
    .join("\n");
}

function normalizeJsonValue(value: unknown, valuePath: string, ancestors: Set<object>): JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new YamlValueError(valuePath, "Numbers must be finite.");
    }

    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new YamlValueError(
        valuePath,
        "Integers must be within the JavaScript safe integer range."
      );
    }

    return value;
  }

  if (typeof value !== "object") {
    throw new YamlValueError(
      valuePath,
      `Unsupported YAML value type: ${typeof value}.`
    );
  }

  if (ancestors.has(value)) {
    throw new YamlValueError(valuePath, "Circular YAML aliases are not supported.");
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        normalizeJsonValue(entry, `${valuePath}[${index}]`, ancestors)
      );
    }

    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new YamlValueError(valuePath, "YAML mappings must produce plain objects.");
    }

    const normalized: { [key: string]: JsonValue } = {};

    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: normalizeJsonValue(entry, pathForKey(valuePath, key), ancestors),
        writable: true
      });
    }

    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

function issueFromYamlError(error: YAMLError): YamlParseIssue {
  const position = error.linePos?.[0];

  return {
    code: "yaml.syntax",
    message: error.message
      .split("\n", 1)[0]
      .replace(/ at line \d+, column \d+:?$/, ""),
    ...(position === undefined
      ? {}
      : { line: position.line, column: position.col })
  };
}

function issueFromValueError(error: unknown): YamlParseIssue {
  if (error instanceof YamlValueError) {
    return {
      code: "yaml.value",
      message: error.message,
      path: error.path
    };
  }

  return {
    code: "yaml.value",
    message: error instanceof Error ? error.message : String(error)
  };
}

function normalizedAliasCount(value: number | undefined): number {
  const maxAliasCount = value ?? 100;

  if (!Number.isSafeInteger(maxAliasCount) || maxAliasCount < 0) {
    throw new RangeError("YAML maxAliasCount must be a non-negative safe integer.");
  }

  return maxAliasCount;
}

function pathForKey(parent: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

class YamlValueError extends Error {
  readonly path: string;

  constructor(valuePath: string, message: string) {
    super(message);
    this.name = "YamlValueError";
    this.path = valuePath;
  }
}
