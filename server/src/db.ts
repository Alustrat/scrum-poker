import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, types } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, lt, count } from "drizzle-orm";
import { settings } from "./settings.js";
import { rooms } from "./schema.js";

// Resolved relative to this module (not process.cwd()) so migrations are
// found whether running compiled dist/db.js or src/db.ts via tsx/vitest,
// and regardless of the process's working directory (e.g. in Docker).
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

// pg returns BIGINT (OID 20) as a string by default to avoid silent precision
// loss; our epoch-ms timestamps are always well under Number.MAX_SAFE_INTEGER.
types.setTypeParser(20, (val: string) => parseInt(val, 10));

export const pool = new Pool({
  host: settings.db.host,
  port: settings.db.port,
  user: settings.db.user,
  password: settings.db.password,
  database: settings.db.name,
  options: settings.db.options,
});

export const db = drizzle(pool);

// `migrationsSchema` defaults to Drizzle's own "drizzle" schema, which is
// shared across every caller. Tests pass their per-file schema here so each
// isolated test schema tracks (and re-applies) migrations independently.
export async function initDb(migrationsSchema?: string): Promise<void> {
  await migrate(db, { migrationsFolder, migrationsSchema });
}

export type RoomRow = typeof rooms.$inferSelect;

export async function insertRoom(room: {
  id: string;
  name: string;
  passwordHash: string | null;
}): Promise<RoomRow> {
  const now = Date.now();
  const [row] = await db
    .insert(rooms)
    .values({
      id: room.id,
      name: room.name,
      password_hash: room.passwordHash,
      created_at: now,
      last_activity_at: now,
    })
    .returning();
  return row;
}

export async function getRoom(id: string): Promise<RoomRow | undefined> {
  const [row] = await db.select().from(rooms).where(eq(rooms.id, id));
  return row;
}

export async function touchRoom(id: string): Promise<void> {
  await db.update(rooms).set({ last_activity_at: Date.now() }).where(eq(rooms.id, id));
}

export async function countRooms(): Promise<number> {
  const [{ value }] = await db.select({ value: count() }).from(rooms);
  return value;
}

export async function deleteInactiveRooms(): Promise<number> {
  const cutoff = Date.now() - settings.roomInactivityMs;
  const result = await db.delete(rooms).where(lt(rooms.last_activity_at, cutoff));
  /* v8 ignore next -- pg always returns a number for rowCount on a DELETE */
  return result.rowCount ?? 0;
}
