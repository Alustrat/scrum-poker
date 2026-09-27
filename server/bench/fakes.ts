// In-memory stand-ins for Redis and the Postgres rooms repository, so the
// benchmarks exercise the application logic deterministically without any
// network I/O (which CodSpeed's CPU simulation does not measure reliably).
import type { RoomRow } from "../src/repositories/roomsRepo.js";

type Value = string | Map<string, string> | Set<string>;

export function createFakeRedis() {
  const store = new Map<string, Value>();

  const hash = (key: string, create = false): Map<string, string> | undefined => {
    let value = store.get(key) as Map<string, string> | undefined;
    if (!value && create) {
      value = new Map();
      store.set(key, value);
    }
    return value;
  };

  const set = (key: string, create = false): Set<string> | undefined => {
    let value = store.get(key) as Set<string> | undefined;
    if (!value && create) {
      value = new Set();
      store.set(key, value);
    }
    return value;
  };

  const client = {
    async hSet(key: string, field: string, value: string) {
      const h = hash(key, true)!;
      const isNew = !h.has(field);
      h.set(field, value);
      return isNew ? 1 : 0;
    },
    async hExists(key: string, field: string) {
      return hash(key)?.has(field) ? 1 : 0;
    },
    async hLen(key: string) {
      return hash(key)?.size ?? 0;
    },
    async hDel(key: string, field: string) {
      const h = hash(key);
      const removed = h?.delete(field) ? 1 : 0;
      if (h && h.size === 0) store.delete(key);
      return removed;
    },
    async hGetAll(key: string) {
      return Object.fromEntries(hash(key) ?? []);
    },
    async sAdd(key: string, member: string) {
      const s = set(key, true)!;
      const isNew = !s.has(member);
      s.add(member);
      return isNew ? 1 : 0;
    },
    async sRem(key: string, member: string) {
      const s = set(key);
      const removed = s?.delete(member) ? 1 : 0;
      if (s && s.size === 0) store.delete(key);
      return removed;
    },
    async sCard(key: string) {
      return set(key)?.size ?? 0;
    },
    async sMembers(key: string) {
      return [...(set(key) ?? [])];
    },
    async get(key: string) {
      return (store.get(key) as string | undefined) ?? null;
    },
    async set(key: string, value: string, options?: { NX?: boolean; PX?: number }) {
      if (options?.NX && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
    async incr(key: string) {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return next;
    },
    async pExpire() {
      return 1;
    },
    // Only the lock release compare-and-delete script is used by the app.
    async eval(_script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) {
      if (store.get(keys[0]) === args[0]) {
        store.delete(keys[0]);
        return 1;
      }
      return 0;
    },
    multi() {
      const queued: Array<() => Promise<unknown>> = [];
      const chain = {
        sMembers(key: string) {
          queued.push(() => client.sMembers(key));
          return chain;
        },
        async exec() {
          return Promise.all(queued.map((op) => op()));
        },
      };
      return chain;
    },
    flushAll() {
      store.clear();
    },
  };

  return client;
}

export function createFakeRoomsRepo() {
  const rooms = new Map<string, RoomRow>();
  return {
    async insertRoom(room: { id: string; name: string; passwordHash: string | null }) {
      const now = Date.now();
      const row: RoomRow = {
        id: room.id,
        name: room.name,
        password_hash: room.passwordHash,
        created_at: now,
        last_activity_at: now,
      };
      rooms.set(row.id, row);
      return row;
    },
    async getRoom(id: string) {
      return rooms.get(id);
    },
    async touchRoom(id: string) {
      const row = rooms.get(id);
      if (row) row.last_activity_at = Date.now();
    },
    async countRooms() {
      return rooms.size;
    },
    async deleteInactiveRooms() {
      return 0;
    },
  };
}
