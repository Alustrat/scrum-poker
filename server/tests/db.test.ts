import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { prepareTestSchema, type TestDbHandle } from "./pg-test-helper.js";

let testDb: TestDbHandle;
let dbModule: typeof import("../src/db.js");
let settingsModule: typeof import("../src/settings.js");

beforeAll(async () => {
  testDb = await prepareTestSchema("db");
  process.env.PG_OPTIONS = `-c search_path=${testDb.schema}`;
  dbModule = await import("../src/db.js");
  settingsModule = await import("../src/settings.js");
  await dbModule.initDb(testDb.schema);
});

afterAll(async () => {
  await dbModule.pool.end();
  await testDb.dropSchema();
});

describe("insertRoom / getRoom", () => {
  it("persists a room without a password and round-trips it", async () => {
    const id = uuid();
    const inserted = await dbModule.insertRoom({ id, name: "Sprint Planning", passwordHash: null });
    expect(inserted.id).toBe(id);
    expect(inserted.name).toBe("Sprint Planning");
    expect(inserted.password_hash).toBeNull();

    const fetched = await dbModule.getRoom(id);
    expect(fetched).toEqual(inserted);
  });

  it("persists a room with a password hash", async () => {
    const id = uuid();
    await dbModule.insertRoom({ id, name: "Private Room", passwordHash: "some-hash" });

    const fetched = await dbModule.getRoom(id);
    expect(fetched?.password_hash).toBe("some-hash");
  });

  it("returns undefined for an unknown room id", async () => {
    expect(await dbModule.getRoom(uuid())).toBeUndefined();
  });
});

describe("touchRoom", () => {
  it("updates last_activity_at to a more recent timestamp", async () => {
    const id = uuid();
    await dbModule.insertRoom({ id, name: "Room", passwordHash: null });

    const staleTimestamp = Date.now() - 100_000;
    await dbModule.pool.query(
      `UPDATE rooms SET last_activity_at = $1 WHERE id = $2`,
      [staleTimestamp, id]
    );

    await dbModule.touchRoom(id);

    const fetched = await dbModule.getRoom(id);
    expect(fetched?.last_activity_at).toBeGreaterThan(staleTimestamp);
  });
});

describe("deleteInactiveRooms", () => {
  it("deletes rooms older than the inactivity cutoff and keeps recent ones", async () => {
    const staleId = uuid();
    const freshId = uuid();
    await dbModule.insertRoom({ id: staleId, name: "Stale", passwordHash: null });
    await dbModule.insertRoom({ id: freshId, name: "Fresh", passwordHash: null });

    const staleTimestamp = Date.now() - settingsModule.settings.roomInactivityMs - 1000;
    await dbModule.pool.query(
      `UPDATE rooms SET last_activity_at = $1 WHERE id = $2`,
      [staleTimestamp, staleId]
    );

    const deletedCount = await dbModule.deleteInactiveRooms();

    expect(deletedCount).toBe(1);
    expect(await dbModule.getRoom(staleId)).toBeUndefined();
    expect(await dbModule.getRoom(freshId)).toBeDefined();
  });

  it("returns 0 when nothing is inactive", async () => {
    expect(await dbModule.deleteInactiveRooms()).toBe(0);
  });
});
