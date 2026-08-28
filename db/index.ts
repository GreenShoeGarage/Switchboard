export type DatabaseStatement = {
  bind(...values: unknown[]): DatabaseStatement;
  all<T>(): Promise<{ results?: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
};

export type DatabaseBinding = {
  prepare(query: string): DatabaseStatement;
  batch(statements: DatabaseStatement[]): Promise<unknown[]>;
};

const BINDING_KEY = "__SWITCHBOARD_DATABASE__" as const;

export function setDatabase(binding: DatabaseBinding) {
  (globalThis as typeof globalThis & { [BINDING_KEY]?: DatabaseBinding })[BINDING_KEY] = binding;
}

export function getDatabase(): DatabaseBinding {
  const binding = (globalThis as typeof globalThis & { [BINDING_KEY]?: DatabaseBinding })[BINDING_KEY];
  if (!binding) throw new Error("The SWITCHBOARD database has not been initialized by the community server.");
  return binding;
}

export function databaseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected database error";
  if (message.includes("no such table")) return "The SWITCHBOARD database schema is unavailable. Apply the bundled migration before retrying.";
  return message;
}
