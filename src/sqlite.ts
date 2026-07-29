export type SqliteBindingValue = string | number | bigint | null | Uint8Array;
export type SqliteValue = SqliteBindingValue | boolean;

export interface SqliteDatabase {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqliteValue[]): void;
  all<T = Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]): T | null;
  close(): void;
}

export interface OpenSqliteDatabaseOptions {
  readonly?: boolean;
  busyTimeoutMs?: number;
}

export type NodeDatabaseSyncConstructor = new (
  path: string,
  options?: { readOnly?: boolean; timeout?: number }
) => {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: SqliteBindingValue[]): void;
    all(...params: SqliteBindingValue[]): unknown[];
    get(...params: SqliteBindingValue[]): unknown;
  };
  close(): void;
};

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const MAX_SQLITE_BUSY_TIMEOUT_MS = 2_147_483_647;

export async function openSqliteDatabase(
  databasePath: string,
  options: OpenSqliteDatabaseOptions = {}
): Promise<SqliteDatabase> {
  const normalizedOptions = normalizeOptions(options);

  if (isBunRuntime()) {
    return openBunSqliteDatabase(databasePath, normalizedOptions);
  }

  return openNodeSqliteDatabase(databasePath, normalizedOptions);
}

async function openBunSqliteDatabase(
  databasePath: string,
  options: Required<OpenSqliteDatabaseOptions>
): Promise<SqliteDatabase> {
  const sqlite = await import("bun:sqlite");
  const database = options.readonly
    ? new sqlite.Database(databasePath, { readonly: true })
    : new sqlite.Database(databasePath);

  database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);

  return {
    exec(sql: string): void {
      database.exec(sql);
    },
    run(sql: string, params: readonly SqliteValue[] = []): void {
      database.query(sql).run(...normalizeParams(params));
    },
    all<T>(sql: string, params: readonly SqliteValue[] = []): T[] {
      return database.query(sql).all(...normalizeParams(params)) as T[];
    },
    get<T>(sql: string, params: readonly SqliteValue[] = []): T | null {
      return (database.query(sql).get(...normalizeParams(params)) as T | null) ?? null;
    },
    close(): void {
      database.close();
    }
  };
}

export async function openNodeSqliteDatabase(
  databasePath: string,
  options: OpenSqliteDatabaseOptions = {}
): Promise<SqliteDatabase> {
  const sqlite = await import("node:sqlite");
  return createNodeSqliteDatabase(
    sqlite.DatabaseSync as unknown as NodeDatabaseSyncConstructor,
    databasePath,
    options
  );
}

export function createNodeSqliteDatabase(
  DatabaseSync: NodeDatabaseSyncConstructor,
  databasePath: string,
  options: OpenSqliteDatabaseOptions = {}
): SqliteDatabase {
  const normalizedOptions = normalizeOptions(options);
  const database = new DatabaseSync(databasePath, {
    readOnly: normalizedOptions.readonly,
    timeout: normalizedOptions.busyTimeoutMs
  });

  return {
    exec(sql: string): void {
      database.exec(sql);
    },
    run(sql: string, params: readonly SqliteValue[] = []): void {
      database.prepare(sql).run(...normalizeParams(params));
    },
    all<T>(sql: string, params: readonly SqliteValue[] = []): T[] {
      return database.prepare(sql).all(...normalizeParams(params)) as T[];
    },
    get<T>(sql: string, params: readonly SqliteValue[] = []): T | null {
      return (database.prepare(sql).get(...normalizeParams(params)) as T | null) ?? null;
    },
    close(): void {
      database.close();
    }
  };
}

function normalizeOptions(options: OpenSqliteDatabaseOptions): Required<OpenSqliteDatabaseOptions> {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS;

  if (
    !Number.isSafeInteger(busyTimeoutMs)
    || busyTimeoutMs < 0
    || busyTimeoutMs > MAX_SQLITE_BUSY_TIMEOUT_MS
  ) {
    throw new RangeError(
      `SQLite busy timeout must be a safe integer between 0 and ${MAX_SQLITE_BUSY_TIMEOUT_MS}.`
    );
  }

  return {
    readonly: options.readonly ?? false,
    busyTimeoutMs
  };
}

function normalizeParams(params: readonly SqliteValue[]): SqliteBindingValue[] {
  return params.map((value) => {
    if (value === true) return 1;
    if (value === false) return 0;
    return value;
  });
}

function isBunRuntime(): boolean {
  return Boolean((globalThis as { Bun?: unknown }).Bun);
}
