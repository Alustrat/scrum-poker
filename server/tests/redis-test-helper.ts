import { createClient } from "redis";
import { settings } from "../src/settings.js";

export interface TestRedisHandle {
  db: number;
  flush: () => Promise<void>;
}

async function withAdminClient<T>(
  db: number,
  fn: (client: ReturnType<typeof createClient>) => Promise<T>
): Promise<T> {
  const client = createClient({
    socket: { host: settings.redis.host, port: settings.redis.port },
    password: settings.redis.password,
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
