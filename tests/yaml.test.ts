import { describe, expect, test } from "bun:test";
import {
  formatYamlParseIssues,
  parseYamlDocument,
  parseYamlDocumentOrThrow,
  YamlDocumentError
} from "../src/yaml";

describe("strict YAML parsing", () => {
  test("parses mappings, lists, and folded block scalars as JSON-compatible data", () => {
    const result = parseYamlDocument(`claim: >
  Agent Memory and Agent Flow share a strict parser.
  YAML content is never executed.
tags:
  - memory
  - flow
enabled: true
`);

    expect(result).toEqual({
      ok: true,
      value: {
        claim: "Agent Memory and Agent Flow share a strict parser. YAML content is never executed.\n",
        tags: ["memory", "flow"],
        enabled: true
      }
    });
  });

  test("preserves prototype-looking keys as ordinary data", () => {
    const value = parseYamlDocumentOrThrow('"__proto__": safe\nconstructor: data\n');

    expect(Object.keys(value as object)).toEqual(["__proto__", "constructor"]);
    expect((value as Record<string, unknown>)["__proto__"]).toBe("safe");
  });

  test("rejects duplicate keys and multiple documents", () => {
    const duplicate = parseYamlDocument("name: first\nname: second\n");
    const multiple = parseYamlDocument("name: first\n---\nname: second\n");

    expect(duplicate.ok).toBe(false);
    expect(multiple.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.issues[0]?.code).toBe("yaml.syntax");
    if (!multiple.ok) expect(multiple.issues[0]?.code).toBe("yaml.syntax");
  });

  test("rejects circular aliases and bounded alias expansion", () => {
    const circular = parseYamlDocument("node: &node\n  self: *node\n");
    const aliases = parseYamlDocument(
      "value: &value [one, two]\ncopy: *value\n",
      { maxAliasCount: 0 }
    );

    expect(circular.ok).toBe(false);
    expect(aliases.ok).toBe(false);
  });

  test("rejects non-JSON numeric values", () => {
    const result = parseYamlDocument("value: .inf\n");

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "yaml.value",
          message: "Numbers must be finite.",
          path: "$.value"
        }
      ]
    });
  });

  test("throws a structured error on demand", () => {
    expect(() => parseYamlDocumentOrThrow("value: [")).toThrow(YamlDocumentError);

    try {
      parseYamlDocumentOrThrow("value: [");
      throw new Error("Expected YAML parsing to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(YamlDocumentError);
      const yamlError = error as YamlDocumentError;
      expect(formatYamlParseIssues(yamlError.issues)).toContain("yaml.syntax");
    }
  });

  test("validates alias-count options", () => {
    expect(() => parseYamlDocument("value: true\n", { maxAliasCount: -1 }))
      .toThrow("YAML maxAliasCount");
  });
});
