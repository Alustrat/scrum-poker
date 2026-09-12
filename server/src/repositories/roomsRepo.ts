import { eq, lt, count } from "drizzle-orm";
import { db } from "../db.js";
import { rooms } from "../schema.js";
import { settings } from "../settings.js";

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
