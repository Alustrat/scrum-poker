import { Client } from "pg";
import { createClient } from "redis";
import { settings } from "../src/settings.js";

export default async function globalSetup(): Promise<void> {
  const client = new Client({
    host: settings.db.host,
    port: settings.db.port,
    user: settings.db.user,
    password: settings.db.password,
    database: settings.db.name,
  });
  try {
    await client.connect();
    await client.end();
  } catch (err) {
    throw new Error(
      `Could not connect to Postgres at ${settings.db.host}:${settings.db.port}. ` +
        `Start it with: docker compose up -d postgres\n${(err as Error).message}`
    );
  }

  const redisClient = createClient({
    socket: { host: settings.redis.host, port: settings.redis.port },
    password: settings.redis.password,
  });
  try {
    await redisClient.connect();
    await redisClient.ping();
    await redisClient.quit();
  } catch (err) {
    throw new Error(
      `Could not connect to Redis at ${settings.redis.host}:${settings.redis.port}. ` +
        `Start it with: docker compose up -d redis\n${(err as Error).message}`
    );
  }
}
