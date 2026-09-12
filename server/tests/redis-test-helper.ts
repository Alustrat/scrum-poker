import { createClient } from "redis";

export interface TestRedisHandle {
  db: number;
  flush: () => Promise<void>;
}

// Reads env vars directly instead of importing settings.js: that module is a
// singleton evaluated once per process, and pg-test-helper.js is imported
// alongside this file before the caller sets process.env.PG_OPTIONS for
// db.ts's later dynamic import — importing settings.js here would freeze
// that shared module too early and silently defeat schema isolation.
async function withAdminClient<T>(
  db: number,
  fn: (client: ReturnType<typeof createClient>) => Promise<T>
): Promise<T> {
  const client = createClient({
    socket: {
      host: process.env.REDIS_HOST ?? "localhost",
      port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
    },
    password: process.env.REDIS_PASSWORD || undefined,
    database: db,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.quit();
  }
}

// Isolates a test file to its own Redis logical database (0-15, standalone mode).
// Point rooms.ts at it by setting process.env.REDIS_DB = String(dbIndex) *before*
// dynamically importing "../src/rooms.js" — settings.ts reads REDIS_DB at import
// time, so the module's pubClient/subClient connect already scoped to this db.
export async function prepareTestRedisDb(dbIndex: number): Promise<TestRedisHandle> {
  await withAdminClient(dbIndex, (client) => client.flushDb());
  return {
    db: dbIndex,
    flush: () => withAdminClient(dbIndex, (client) => client.flushDb()),
  };
}
