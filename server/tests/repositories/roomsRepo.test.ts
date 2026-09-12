import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { prepareTestSchema, type TestDbHandle } from "../pg-test-helper.js";

let testDb: TestDbHandle;
let dbModule: typeof import("../../src/db.js");
let roomsRepoModule: typeof import("../../src/repositories/roomsRepo.js");
let settingsModule: typeof import("../../src/settings.js");

beforeAll(async () => {
  testDb = await prepareTestSchema("rooms_repo");
  process.env.PG_OPTIONS = `-c search_path=${testDb.schema}`;
  dbModule = await import("../../src/db.js");
  roomsRepoModule = await import("../../src/repositories/roomsRepo.js");
  settingsModule = await import("../../src/settings.js");
  await dbModule.initDb(testDb.schema);
});

afterAll(async () => {
  await dbModule.pool.end();
  await testDb.dropSchema();
});

describe("insertRoom / getRoom", () => {
  it("persists a room without a password and round-trips it", async () => {
    const id = uuid();
    const inserted = await roomsRepoModule.insertRoom({ id, name: "Sprint Planning", passwordHash: null });
    expect(inserted.id).toBe(id);
    expect(inserted.name).toBe("Sprint Planning");
    expect(inserted.password_hash).toBeNull();

    const fetched = await roomsRepoModule.getRoom(id);
    expect(fetched).toEqual(inserted);
  });

  it("persists a room with a password hash", async () => {
    const id = uuid();
    await roomsRepoModule.insertRoom({ id, name: "Private Room", passwordHash: "some-hash" });

    const fetched = await roomsRepoModule.getRoom(id);
    expect(fetched?.password_hash).toBe("some-hash");
  });

  it("returns undefined for an unknown room id", async () => {
    expect(await roomsRepoModule.getRoom(uuid())).toBeUndefined();
  });
});

describe("touchRoom", () => {
  it("updates last_activity_at to a more recent timestamp", async () => {
    const id = uuid();
    await roomsRepoModule.insertRoom({ id, name: "Room", passwordHash: null });

    const staleTimestamp = Date.now() - 100_000;
    await dbModule.pool.query(
      `UPDATE rooms SET last_activity_at = $1 WHERE id = $2`,
      [staleTimestamp, id]
    );

    await roomsRepoModule.touchRoom(id);

    const fetched = await roomsRepoModule.getRoom(id);
    expect(fetched?.last_activity_at).toBeGreaterThan(staleTimestamp);
  });
});

describe("deleteInactiveRooms", () => {
  it("deletes rooms older than the inactivity cutoff and keeps recent ones", async () => {
    const staleId = uuid();
    const freshId = uuid();
    await roomsRepoModule.insertRoom({ id: staleId, name: "Stale", passwordHash: null });
    await roomsRepoModule.insertRoom({ id: freshId, name: "Fresh", passwordHash: null });

    const staleTimestamp = Date.now() - settingsModule.settings.roomInactivityMs - 1000;
    await dbModule.pool.query(
      `UPDATE rooms SET last_activity_at = $1 WHERE id = $2`,
      [staleTimestamp, staleId]
    );

    const deletedCount = await roomsRepoModule.deleteInactiveRooms();

    expect(deletedCount).toBe(1);
    expect(await roomsRepoModule.getRoom(staleId)).toBeUndefined();
    expect(await roomsRepoModule.getRoom(freshId)).toBeDefined();
  });

  it("returns 0 when nothing is inactive", async () => {
    expect(await roomsRepoModule.deleteInactiveRooms()).toBe(0);
  });
});
