import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import type { DatabaseBinding, DatabaseStatement } from "@/db";

class SQLiteStatement implements DatabaseStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new SQLiteStatement(this.statement, values);
  }

  async all<T>() {
    return { results: this.statement.all(...this.values.map(sqliteValue)) as T[] };
  }

  async first<T>() {
    return (this.statement.get(...this.values.map(sqliteValue)) as T | undefined) ?? null;
  }

  async run() {
    const result = this.statement.run(...this.values.map(sqliteValue));
    return { success: true, meta: { changes: Number(result.changes), lastRowId: Number(result.lastInsertRowid) } };
  }
}

function sqliteValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (value instanceof Uint8Array) return value as SQLInputValue;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  throw new TypeError(`Unsupported SQLite binding value: ${Object.prototype.toString.call(value)}`);
}

export type SQLiteBinding = DatabaseBinding & {
  close(): void;
  exec(sql: string): void;
};

export function createSQLiteBinding(databasePath: string): SQLiteBinding {
  const resolvedPath = resolve(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const database = new DatabaseSync(resolvedPath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");

  return {
    prepare(query: string) {
      return new SQLiteStatement(database.prepare(query));
    },
    async batch(statements: DatabaseStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      database.close();
    },
    exec(sql: string) {
      database.exec(sql);
    },
  };
}

export async function applySQLiteMigrations(database: SQLiteBinding, migrationsDirectory: string) {
  database.exec(`CREATE TABLE IF NOT EXISTS switchboard_migrations (
    name TEXT PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const rows = await database.prepare("SELECT name FROM switchboard_migrations ORDER BY name").all<{ name: string }>();
  const applied = new Set((rows.results ?? []).map((row) => row.name));
  const names = readdirSync(migrationsDirectory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();

  for (const name of names) {
    if (applied.has(name)) continue;
    const sql = readFileSync(resolve(migrationsDirectory, name), "utf8").replaceAll("--> statement-breakpoint", "");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      await database.prepare("INSERT INTO switchboard_migrations (name, applied_at) VALUES (?, ?)").bind(name, Date.now()).run();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}
