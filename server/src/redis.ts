import { createClient } from "redis";
import { settings } from "./settings.js";

export const pubClient = createClient({
  socket: { host: settings.redis.host, port: settings.redis.port },
  password: settings.redis.password,
  database: settings.redis.db,
});

export const subClient = pubClient.duplicate();

export async function connectRedis(): Promise<{
  pubClient: typeof pubClient;
  subClient: typeof subClient;
}> {
  await Promise.all([pubClient.connect(), subClient.connect()]);
  return { pubClient, subClient };
}
