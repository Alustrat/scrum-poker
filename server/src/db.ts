import { Pool, types } from "pg";
import { settings } from "./settings.js";

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

export const ROOMS_DDL = `
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password_hash TEXT,
    created_at BIGINT NOT NULL,
    last_activity_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rooms_last_activity ON rooms (last_activity_at);
`;

export async function initDb(): Promise<void> {
  await pool.query(ROOMS_DDL);
}

export interface RoomRow {
  id: string;
  name: string;
  password_hash: string | null;
  created_at: number;
  last_activity_at: number;
}

export async function insertRoom(room: {
  id: string;
  name: string;
  passwordHash: string | null;
}): Promise<RoomRow> {
  const now = Date.now();
  await pool.query(
    `INSERT INTO rooms (id, name, password_hash, created_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [room.id, room.name, room.passwordHash, now, now]
  );
  return (await getRoom(room.id))!;
}

export async function getRoom(id: string): Promise<RoomRow | undefined> {
  const result = await pool.query<RoomRow>(`SELECT * FROM rooms WHERE id = $1`, [id]);
  return result.rows[0];
}

export async function touchRoom(id: string): Promise<void> {
  await pool.query(`UPDATE rooms SET last_activity_at = $1 WHERE id = $2`, [
    Date.now(),
    id,
  ]);
}

export async function countRooms(): Promise<number> {
  const result = await pool.query<{ count: number }>(`SELECT COUNT(*) AS count FROM rooms`);
  return Number(result.rows[0].count);
}

export async function deleteInactiveRooms(): Promise<number> {
  const cutoff = Date.now() - settings.roomInactivityMs;
  const result = await pool.query(`DELETE FROM rooms WHERE last_activity_at < $1`, [
    cutoff,
  ]);
  /* v8 ignore next -- pg always returns a number for rowCount on a DELETE */
  return result.rowCount ?? 0;
}
