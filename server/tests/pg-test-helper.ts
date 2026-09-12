import { Client } from "pg";
import { randomBytes } from "node:crypto";

export interface TestDbHandle {
  schema: string;
  dropSchema: () => Promise<void>;
}

function uniqueSchemaName(label: string): string {
  const suffix = randomBytes(4).toString("hex");
  return `test_${label}_${suffix}`.toLowerCase();
}

// Reads env vars directly instead of importing settings.js: that module is a
// singleton evaluated once per process, and this helper runs *before* the
// caller sets process.env.PG_OPTIONS for db.ts's later dynamic import (see
// prepareTestSchema below) — importing settings.js here would freeze it with
// options: undefined, silently defeating the schema isolation entirely.
async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: process.env.PG_HOST ?? "localhost",
    port: process.env.PG_PORT ? Number(process.env.PG_PORT) : 5432,
    user: process.env.PG_USER ?? "postgres",
    password: process.env.PG_PASSWORD ?? "postgres",
    database: process.env.PG_DATABASE ?? "scrum_poker",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Creates a fresh, uniquely-named Postgres schema for a test file to run against.
// Point db.ts at it by setting process.env.PG_OPTIONS = `-c search_path=${schema}`
// *before* dynamically importing "../src/db.js" — every connection db.ts's pool
// opens then has this schema pinned via the connection startup options, which is
// safe under pooling (unlike a per-query `SET search_path`).
export async function prepareTestSchema(label: string): Promise<TestDbHandle> {
  const schema = uniqueSchemaName(label);
  await withAdminClient((client) => client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`));

  return {
    schema,
    dropSchema: async () => {
      await withAdminClient((client) => client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
    },
  };
}
