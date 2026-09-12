import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import { v4 as uuid } from "uuid";
import { prepareTestSchema, type TestDbHandle } from "./pg-test-helper.js";
import { prepareTestRedisDb, type TestRedisHandle } from "./redis-test-helper.js";

let testDb: TestDbHandle;
let testRedis: TestRedisHandle;
let roomsModule: typeof import("../src/rooms.js");
let dbModule: typeof import("../src/db.js");
let redisModule: typeof import("../src/redis.js");
let app: express.Express;

beforeAll(async () => {
  testDb = await prepareTestSchema("rooms");
  process.env.PG_OPTIONS = `-c search_path=${testDb.schema}`;
  testRedis = await prepareTestRedisDb(2);
  process.env.REDIS_DB = String(testRedis.db);
  dbModule = await import("../src/db.js");
  await dbModule.initDb();
  redisModule = await import("../src/redis.js");
  await redisModule.connectRedis();
  roomsModule = await import("../src/rooms.js");

  app = express();
  app.use(express.json());
  app.use("/api/rooms", roomsModule.roomsRouter);
});

afterAll(async () => {
  await dbModule.pool.end();
  await testDb.dropSchema();
  await redisModule.pubClient.quit();
  await redisModule.subClient.quit();
  await testRedis.flush();
});

describe("POST /api/rooms", () => {
  it("creates a room with a valid name", async () => {
    const res = await request(app).post("/api/rooms").send({ name: "Sprint 12" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Sprint 12" });
    expect(typeof res.body.id).toBe("string");
  });

  it("trims whitespace from the name", async () => {
    const res = await request(app).post("/api/rooms").send({ name: "  Padded  " });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Padded");
  });

  it("rejects a missing name", async () => {
    const res = await request(app).post("/api/rooms").send({});
    expect(res.status).toBe(400);
  });

  it("rejects a request sent with no body at all", async () => {
    const res = await request(app).post("/api/rooms");
    expect(res.status).toBe(400);
  });

  it("rejects a blank name", async () => {
    const res = await request(app).post("/api/rooms").send({ name: "   " });
    expect(res.status).toBe(400);
  });

  it("hashes the password when provided, rather than storing it in plaintext", async () => {
    const res = await request(app)
      .post("/api/rooms")
      .send({ name: "Private", password: "secret123" });
    expect(res.status).toBe(201);

    const room = await dbModule.getRoom(res.body.id);
    expect(room?.password_hash).toBeTruthy();
    expect(room?.password_hash).not.toBe("secret123");
    expect(await bcrypt.compare("secret123", room!.password_hash!)).toBe(true);
  });

  it("stores no password hash when password is omitted", async () => {
    const res = await request(app).post("/api/rooms").send({ name: "Open room" });
    const room = await dbModule.getRoom(res.body.id);
    expect(room?.password_hash).toBeNull();
  });

  it("rejects a room name over the max length", async () => {
    const res = await request(app)
      .post("/api/rooms")
      .send({ name: "x".repeat(101) });
    expect(res.status).toBe(400);
  });

  it("rejects a password over the max length", async () => {
    const res = await request(app)
      .post("/api/rooms")
      .send({ name: "Room", password: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("rejects room creation once the global room cap is reached", async () => {
    const settingsModule = await import("../src/settings.js");
    const originalMax = settingsModule.settings.maxRooms;
    const currentCount = await dbModule.countRooms();
    (settingsModule.settings as { maxRooms: number }).maxRooms = currentCount;
    try {
      const res = await request(app).post("/api/rooms").send({ name: "One too many" });
      expect(res.status).toBe(429);
    } finally {
      (settingsModule.settings as { maxRooms: number }).maxRooms = originalMax;
    }
  });

  it("allows creation again once under the cap", async () => {
    const settingsModule = await import("../src/settings.js");
    const originalMax = settingsModule.settings.maxRooms;
    const currentCount = await dbModule.countRooms();
    (settingsModule.settings as { maxRooms: number }).maxRooms = currentCount + 1;
    try {
      const res = await request(app).post("/api/rooms").send({ name: "Just fits" });
      expect(res.status).toBe(201);
    } finally {
      (settingsModule.settings as { maxRooms: number }).maxRooms = originalMax;
    }
  });

  it("rate-limits repeated room creation from the same address", async () => {
    const settingsModule = await import("../src/settings.js");
    const original = settingsModule.settings.roomCreateRateLimit;
    // Earlier tests in this file already consumed rate-limit slots for this
    // IP; clear them so this test starts from a known, deterministic count.
    const rateLimitKeys = await redisModule.pubClient.keys("ratelimit:rooms:create:*");
    if (rateLimitKeys.length > 0) await redisModule.pubClient.del(rateLimitKeys);
    (
      settingsModule.settings as { roomCreateRateLimit: { windowMs: number; max: number } }
    ).roomCreateRateLimit = { windowMs: 60_000, max: 1 };
    try {
      const first = await request(app).post("/api/rooms").send({ name: "Rate 1" });
      expect(first.status).toBe(201);
      const second = await request(app).post("/api/rooms").send({ name: "Rate 2" });
      expect(second.status).toBe(429);
    } finally {
      (
        settingsModule.settings as { roomCreateRateLimit: { windowMs: number; max: number } }
      ).roomCreateRateLimit = original;
    }
  });

  it("responds 503 when the room-creation lock can't be acquired in time", async () => {
    const settingsModule = await import("../src/settings.js");
    const lockModule = await import("../src/lock.js");
    const originalMaxWaitMs = settingsModule.settings.lock.maxWaitMs;
    (settingsModule.settings as { lock: { maxWaitMs: number } }).lock.maxWaitMs = 50;
    const rateLimitKeys = await redisModule.pubClient.keys("ratelimit:rooms:create:*");
    if (rateLimitKeys.length > 0) await redisModule.pubClient.del(rateLimitKeys);

    const holderToken = await lockModule.acquireLock("lock:rooms:create", { ttlMs: 5000 });
    try {
      const res = await request(app).post("/api/rooms").send({ name: "Contended" });
      expect(res.status).toBe(503);
    } finally {
      await lockModule.releaseLock("lock:rooms:create", holderToken!);
      (settingsModule.settings as { lock: { maxWaitMs: number } }).lock.maxWaitMs =
        originalMaxWaitMs;
    }
  });
});

describe("GET /api/rooms/:id", () => {
  it("returns the room with hasPassword=false when no password was set", async () => {
    const createRes = await request(app).post("/api/rooms").send({ name: "Public" });
    const res = await request(app).get(`/api/rooms/${createRes.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: createRes.body.id,
      name: "Public",
      hasPassword: false,
    });
  });

  it("returns hasPassword=true when a password was set", async () => {
    const createRes = await request(app)
      .post("/api/rooms")
      .send({ name: "Locked", password: "hunter2" });
    const res = await request(app).get(`/api/rooms/${createRes.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.hasPassword).toBe(true);
  });

  it("returns 404 for an unknown room id", async () => {
    const res = await request(app).get("/api/rooms/does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe("room state (Redis-backed)", () => {
  it("returns an empty state for a room nobody has joined", async () => {
    const state = await roomsModule.getRoomState(uuid());
    expect(state.revealed).toBe(false);
    expect(state.participants.size).toBe(0);
  });

  it("joinParticipant adds a participant visible in getRoomState", async () => {
    const roomId = uuid();
    const clientId = uuid();
    await roomsModule.joinParticipant(roomId, clientId, "socket-1", "Dana");

    const state = await roomsModule.getRoomState(roomId);
    expect(state.participants.size).toBe(1);
    const participant = state.participants.get(clientId);
    expect(participant).toMatchObject({ clientId, name: "Dana", vote: null });
    expect(participant?.socketIds.has("socket-1")).toBe(true);
  });

  it("castVote sets and clears a participant's vote", async () => {
    const roomId = uuid();
    const clientId = uuid();
    await roomsModule.joinParticipant(roomId, clientId, "socket-1", "Erin");

    await roomsModule.castVote(roomId, clientId, "5");
    expect((await roomsModule.getRoomState(roomId)).participants.get(clientId)?.vote).toBe("5");

    await roomsModule.castVote(roomId, clientId, null);
    expect((await roomsModule.getRoomState(roomId)).participants.get(clientId)?.vote).toBeNull();
  });

  it("revealVotes and resetRound toggle the revealed flag and clear votes", async () => {
    const roomId = uuid();
    const clientId = uuid();
    await roomsModule.joinParticipant(roomId, clientId, "socket-1", "Frank");
    await roomsModule.castVote(roomId, clientId, "8");

    await roomsModule.revealVotes(roomId);
    expect((await roomsModule.getRoomState(roomId)).revealed).toBe(true);

    await roomsModule.resetRound(roomId);
    const state = await roomsModule.getRoomState(roomId);
    expect(state.revealed).toBe(false);
    expect(state.participants.get(clientId)?.vote).toBeNull();
  });

  it("leaveSocket removes a socket and, once the last one is gone, removes the room entirely", async () => {
    const roomId = uuid();
    const clientId = uuid();
    await roomsModule.joinParticipant(roomId, clientId, "socket-1", "Gina");
    await roomsModule.joinParticipant(roomId, clientId, "socket-2", "Gina");

    await roomsModule.leaveSocket(roomId, clientId, "socket-1");
    expect(await roomsModule.roomExists(roomId)).toBe(true);

    await roomsModule.leaveSocket(roomId, clientId, "socket-2");
    expect(await roomsModule.roomExists(roomId)).toBe(false);
  });

  it("tryJoinParticipant rejects a new participant once the room is at capacity", async () => {
    const settingsModule = await import("../src/settings.js");
    const originalMax = settingsModule.settings.maxParticipantsPerRoom;
    (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom = 1;
    try {
      const roomId = uuid();
      await roomsModule.tryJoinParticipant(roomId, uuid(), "socket-1", "First");
      await expect(
        roomsModule.tryJoinParticipant(roomId, uuid(), "socket-2", "Second")
      ).rejects.toBeInstanceOf(roomsModule.RoomFullError);
    } finally {
      (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom =
        originalMax;
    }
  });

  it("tryJoinParticipant still allows an existing participant to add another socket at capacity", async () => {
    const settingsModule = await import("../src/settings.js");
    const originalMax = settingsModule.settings.maxParticipantsPerRoom;
    (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom = 1;
    try {
      const roomId = uuid();
      const clientId = uuid();
      await roomsModule.tryJoinParticipant(roomId, clientId, "socket-1", "Solo");
      await roomsModule.tryJoinParticipant(roomId, clientId, "socket-2", "Solo");
      const state = await roomsModule.getRoomState(roomId);
      expect(state.participants.get(clientId)?.socketIds.size).toBe(2);
    } finally {
      (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom =
        originalMax;
    }
  });

  it("tryJoinParticipant rejects an existing participant once past the per-participant socket cap", async () => {
    const settingsModule = await import("../src/settings.js");
    const originalMax = settingsModule.settings.maxSocketsPerParticipant;
    (settingsModule.settings as { maxSocketsPerParticipant: number }).maxSocketsPerParticipant = 1;
    try {
      const roomId = uuid();
      const clientId = uuid();
      await roomsModule.tryJoinParticipant(roomId, clientId, "socket-1", "Tabby");
      await expect(
        roomsModule.tryJoinParticipant(roomId, clientId, "socket-2", "Tabby")
      ).rejects.toBeInstanceOf(roomsModule.TooManyConnectionsError);
    } finally {
      (settingsModule.settings as { maxSocketsPerParticipant: number }).maxSocketsPerParticipant =
        originalMax;
    }
  });

  it("tryJoinParticipant serializes concurrent joins so the room cap can't be raced past", async () => {
    const settingsModule = await import("../src/settings.js");
    const originalMax = settingsModule.settings.maxParticipantsPerRoom;
    (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom = 5;
    try {
      const roomId = uuid();
      const attempts = Array.from({ length: 10 }, (_, i) =>
        roomsModule
          .tryJoinParticipant(roomId, uuid(), `socket-${i}`, `User${i}`)
          .then(() => true)
          .catch(() => false)
      );
      const results = await Promise.all(attempts);
      const succeeded = results.filter(Boolean).length;
      expect(succeeded).toBe(5);

      const state = await roomsModule.getRoomState(roomId);
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
    await dbModule.insertRoom({ id: staleId, name: "Stale", passwordHash: null });
    await dbModule.insertRoom({ id: freshId, name: "Fresh", passwordHash: null });

    const settingsModule = await import("../src/settings.js");
    const staleTimestamp = Date.now() - settingsModule.settings.roomInactivityMs - 1000;
    await dbModule.pool.query(`UPDATE rooms SET last_activity_at = $1 WHERE id = $2`, [
      staleTimestamp,
      staleId,
    ]);

    // Run the real interval on a tiny period instead of the production 1h one,
    // so the test observes an actual tick without mocking timers around real DB I/O.
    const originalIntervalMs = settingsModule.settings.cleanupIntervalMs;
    (settingsModule.settings as { cleanupIntervalMs: number }).cleanupIntervalMs = 20;

    const handle = roomsModule.startCleanupJob();
    try {
      await vi.waitFor(async () => {
        expect(await dbModule.getRoom(staleId)).toBeUndefined();
      });
      expect(await dbModule.getRoom(freshId)).toBeDefined();
    } finally {
      clearInterval(handle);
      (settingsModule.settings as { cleanupIntervalMs: number }).cleanupIntervalMs =
        originalIntervalMs;
    }
  });
});
