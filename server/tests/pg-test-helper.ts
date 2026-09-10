import { Client } from "pg";
import { randomBytes } from "node:crypto";
import { settings } from "../src/settings.js";

export interface TestDbHandle {
  schema: string;
  dropSchema: () => Promise<void>;
}

function uniqueSchemaName(label: string): string {
  const suffix = randomBytes(4).toString("hex");
  return `test_${label}_${suffix}`.toLowerCase();
}

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: settings.db.host,
    port: settings.db.port,
    user: settings.db.user,
    password: settings.db.password,
    database: settings.db.name,
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
