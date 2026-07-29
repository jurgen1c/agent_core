import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createNodeSqliteDatabase,
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  MAX_SQLITE_BUSY_TIMEOUT_MS,
  openSqliteDatabase,
  type NodeDatabaseSyncConstructor,
  type SqliteBindingValue
} from "../src/sqlite";

describe("SQLite portability", () => {
  test("opens a Bun database with the default busy timeout", async () => {
    const database = await openSqliteDatabase(tempDatabasePath());

    try {
      expect(database.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout)
        .toBe(DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      database.close();
    }
  });

  test("supports read-only connections", async () => {
    const databasePath = tempDatabasePath();
    const writable = await openSqliteDatabase(databasePath);

    try {
      writable.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, active INTEGER NOT NULL)");
      writable.run("INSERT INTO items (active) VALUES (?)", [true]);
    } finally {
      writable.close();
    }

    const readonly = await openSqliteDatabase(databasePath, { readonly: true });

    try {
      expect(readonly.get<{ active: number }>("SELECT active FROM items")?.active).toBe(1);
      expect(() => readonly.run("INSERT INTO items (active) VALUES (?)", [false])).toThrow();
    } finally {
      readonly.close();
    }
  });

  test("maps the Node DatabaseSync API and normalizes booleans", () => {
    const calls: Array<{
      operation: string;
      sql?: string;
      params?: SqliteBindingValue[];
    }> = [];
    let opened:
      | { path: string; options?: { readOnly?: boolean; timeout?: number } }
      | undefined;
    const DatabaseSync = class {
      constructor(databasePath: string, options?: { readOnly?: boolean; timeout?: number }) {
        opened = { path: databasePath, options };
      }

      exec(sql: string): void {
        calls.push({ operation: "exec", sql });
      }

      prepare(sql: string) {
        return {
          run: (...params: SqliteBindingValue[]) =>
            calls.push({ operation: "run", sql, params }),
          all: (...params: SqliteBindingValue[]) => {
            calls.push({ operation: "all", sql, params });
            return [{ active: 1 }];
          },
          get: (...params: SqliteBindingValue[]) => {
            calls.push({ operation: "get", sql, params });
            return undefined;
          }
        };
      }

      close(): void {
        calls.push({ operation: "close" });
      }
    } as NodeDatabaseSyncConstructor;
    const databasePath = tempDatabasePath();
    const database = createNodeSqliteDatabase(
      DatabaseSync,
      databasePath,
      { readonly: true, busyTimeoutMs: 250 }
    );

    try {
      database.exec("CREATE TABLE items (active INTEGER NOT NULL)");
      database.run("INSERT INTO items (active) VALUES (?)", [true]);
      expect(database.all<{ active: number }>("SELECT active FROM items")).toEqual([{ active: 1 }]);
      expect(database.get("SELECT active FROM items WHERE active = ?", [false])).toBeNull();
    } finally {
      database.close();
    }

    expect(opened).toEqual({
      path: databasePath,
      options: { readOnly: true, timeout: 250 }
    });
    expect(calls).toEqual([
      { operation: "exec", sql: "CREATE TABLE items (active INTEGER NOT NULL)" },
      { operation: "run", sql: "INSERT INTO items (active) VALUES (?)", params: [1] },
      { operation: "all", sql: "SELECT active FROM items", params: [] },
      {
        operation: "get",
        sql: "SELECT active FROM items WHERE active = ?",
        params: [0]
      },
      { operation: "close" }
    ]);
  });

  test("rejects invalid busy timeouts before opening a database", async () => {
    const databasePath = tempDatabasePath();

    await expect(openSqliteDatabase(databasePath, { busyTimeoutMs: -1 })).rejects.toThrow(
      "SQLite busy timeout"
    );
    await expect(
      openSqliteDatabase(databasePath, {
        busyTimeoutMs: MAX_SQLITE_BUSY_TIMEOUT_MS + 1
      })
    ).rejects.toThrow("SQLite busy timeout");
  });
});

function tempDatabasePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-core-sqlite-")),
    "database.sqlite"
  );
}
