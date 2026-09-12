import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { prepareTestSchema, type TestDbHandle } from "../pg-test-helper.js";
import { prepareTestRedisDb, type TestRedisHandle } from "../redis-test-helper.js";

let testDb: TestDbHandle;
let testRedis: TestRedisHandle;
let roomServiceModule: typeof import("../../src/services/roomService.js");
let dbModule: typeof import("../../src/db.js");
let roomsRepoModule: typeof import("../../src/repositories/roomsRepo.js");
let redisModule: typeof import("../../src/redis.js");

beforeAll(async () => {
  testDb = await prepareTestSchema("room_service");
  process.env.PG_OPTIONS = `-c search_path=${testDb.schema}`;
  testRedis = await prepareTestRedisDb(5);
  process.env.REDIS_DB = String(testRedis.db);
  dbModule = await import("../../src/db.js");
  await dbModule.initDb(testDb.schema);
  roomsRepoModule = await import("../../src/repositories/roomsRepo.js");
  redisModule = await import("../../src/redis.js");
  await redisModule.connectRedis();
  roomServiceModule = await import("../../src/services/roomService.js");
});

afterAll(async () => {
  await dbModule.pool.end();
  await testDb.dropSchema();
  await redisModule.pubClient.quit();
  await redisModule.subClient.quit();
  await testRedis.flush();
});

describe("room state (Redis-backed)", () => {
  it("returns an empty state for a room nobody has joined", async () => {
    const state = await roomServiceModule.getRoomState(uuid());
    expect(state.revealed).toBe(false);
    expect(state.participants.size).toBe(0);
  });

  it("joinParticipant adds a participant visible in getRoomState", async () => {
    const roomId = uuid();
    const clientId = uuid();
    await roomServiceModule.joinParticipant(roomId, clientId, "socket-1", "Dana");

    const state = await roomServiceModule.getRoomState(roomId);
    expect(state.participants.size).toBe(1);
    const participant = state.participants.get(clientId);
    expect(participant).toMatchObject({ clientId, name: "Dana", vote: null });
    expect(participant?.socketIds.has("socket-1")).toBe(true);
  });

  it("castVote sets and clears a participant's vote", async () => {
    const roomId = uuid();
    const clientId = uuid();
    await roomServiceModule.joinParticipant(roomId, clientId, "socket-1", "Erin");

    await roomServiceModule.castVote(roomId, clientId, "5");
    expect((await roomServiceModule.getRoomState(roomId)).participants.get(clientId)?.vote).toBe("5");

    await roomServiceModule.castVote(roomId, clientId, null);
    expect((await roomServiceModule.getRoomState(roomId)).participants.get(clientId)?.vote).toBeNull();
  });

  it("revealVotes and resetRound toggle the revealed flag and clear votes", async () => {
    const roomId = uuid();
    const clientId = uuid();
    await roomServiceModule.joinParticipant(roomId, clientId, "socket-1", "Frank");
    await roomServiceModule.castVote(roomId, clientId, "8");

    await roomServiceModule.revealVotes(roomId);
    expect((await roomServiceModule.getRoomState(roomId)).revealed).toBe(true);

    await roomServiceModule.resetRound(roomId);
    const state = await roomServiceModule.getRoomState(roomId);
    expect(state.revealed).toBe(false);
    expect(state.participants.get(clientId)?.vote).toBeNull();
  });

  it("leaveSocket removes a socket and, once the last one is gone, removes the room entirely", async () => {
    const roomId = uuid();
    const clientId = uuid();
    await roomServiceModule.joinParticipant(roomId, clientId, "socket-1", "Gina");
    await roomServiceModule.joinParticipant(roomId, clientId, "socket-2", "Gina");

    await roomServiceModule.leaveSocket(roomId, clientId, "socket-1");
    expect(await roomServiceModule.roomExists(roomId)).toBe(true);

    await roomServiceModule.leaveSocket(roomId, clientId, "socket-2");
    expect(await roomServiceModule.roomExists(roomId)).toBe(false);
  });

  it("tryJoinParticipant rejects a new participant once the room is at capacity", async () => {
    const settingsModule = await import("../../src/settings.js");
    const originalMax = settingsModule.settings.maxParticipantsPerRoom;
    (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom = 1;
    try {
      const roomId = uuid();
      await roomServiceModule.tryJoinParticipant(roomId, uuid(), "socket-1", "First");
      await expect(
        roomServiceModule.tryJoinParticipant(roomId, uuid(), "socket-2", "Second")
      ).rejects.toBeInstanceOf(roomServiceModule.RoomFullError);
    } finally {
      (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom =
        originalMax;
    }
  });

  it("tryJoinParticipant still allows an existing participant to add another socket at capacity", async () => {
    const settingsModule = await import("../../src/settings.js");
    const originalMax = settingsModule.settings.maxParticipantsPerRoom;
    (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom = 1;
    try {
      const roomId = uuid();
      const clientId = uuid();
      await roomServiceModule.tryJoinParticipant(roomId, clientId, "socket-1", "Solo");
      await roomServiceModule.tryJoinParticipant(roomId, clientId, "socket-2", "Solo");
      const state = await roomServiceModule.getRoomState(roomId);
      expect(state.participants.get(clientId)?.socketIds.size).toBe(2);
    } finally {
      (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom =
        originalMax;
    }
  });

  it("tryJoinParticipant rejects an existing participant once past the per-participant socket cap", async () => {
    const settingsModule = await import("../../src/settings.js");
    const originalMax = settingsModule.settings.maxSocketsPerParticipant;
    (settingsModule.settings as { maxSocketsPerParticipant: number }).maxSocketsPerParticipant = 1;
    try {
      const roomId = uuid();
      const clientId = uuid();
      await roomServiceModule.tryJoinParticipant(roomId, clientId, "socket-1", "Tabby");
      await expect(
        roomServiceModule.tryJoinParticipant(roomId, clientId, "socket-2", "Tabby")
      ).rejects.toBeInstanceOf(roomServiceModule.TooManyConnectionsError);
    } finally {
      (settingsModule.settings as { maxSocketsPerParticipant: number }).maxSocketsPerParticipant =
        originalMax;
    }
  });

  it("tryJoinParticipant serializes concurrent joins so the room cap can't be raced past", async () => {
    const settingsModule = await import("../../src/settings.js");
    const originalMax = settingsModule.settings.maxParticipantsPerRoom;
    (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom = 5;
    try {
      const roomId = uuid();
      const attempts = Array.from({ length: 10 }, (_, i) =>
        roomServiceModule
          .tryJoinParticipant(roomId, uuid(), `socket-${i}`, `User${i}`)
          .then(() => true)
          .catch(() => false)
      );
      const results = await Promise.all(attempts);
      const succeeded = results.filter(Boolean).length;
      expect(succeeded).toBe(5);

      const state = await roomServiceModule.getRoomState(roomId);
      expect(state.participants.size).toBe(5);
    } finally {
      (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom =
        originalMax;
    }
  });
});

describe("startCleanupJob", () => {
  it("periodically deletes inactive rooms and leaves recent ones alone", async () => {
    const staleId = uuid();
    const freshId = uuid();
    await roomsRepoModule.insertRoom({ id: staleId, name: "Stale", passwordHash: null });
    await roomsRepoModule.insertRoom({ id: freshId, name: "Fresh", passwordHash: null });

    const settingsModule = await import("../../src/settings.js");
    const staleTimestamp = Date.now() - settingsModule.settings.roomInactivityMs - 1000;
    await dbModule.pool.query(`UPDATE rooms SET last_activity_at = $1 WHERE id = $2`, [
      staleTimestamp,
      staleId,
    ]);

    // Run the real interval on a tiny period instead of the production 1h one,
    // so the test observes an actual tick without mocking timers around real DB I/O.
    const originalIntervalMs = settingsModule.settings.cleanupIntervalMs;
    (settingsModule.settings as { cleanupIntervalMs: number }).cleanupIntervalMs = 20;

    const handle = roomServiceModule.startCleanupJob();
    try {
      await vi.waitFor(async () => {
        expect(await roomsRepoModule.getRoom(staleId)).toBeUndefined();
      });
      expect(await roomsRepoModule.getRoom(freshId)).toBeDefined();
    } finally {
      clearInterval(handle);
      (settingsModule.settings as { cleanupIntervalMs: number }).cleanupIntervalMs =
        originalIntervalMs;
    }
  });
});
