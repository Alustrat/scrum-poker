import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import { prepareTestSchema, type TestDbHandle } from "../pg-test-helper.js";
import { prepareTestRedisDb, type TestRedisHandle } from "../redis-test-helper.js";

let testDb: TestDbHandle;
let testRedis: TestRedisHandle;
let roomsRouteModule: typeof import("../../src/controllers/rooms.js");
let dbModule: typeof import("../../src/db.js");
let roomsRepoModule: typeof import("../../src/repositories/roomsRepo.js");
let redisModule: typeof import("../../src/redis.js");
let app: express.Express;

beforeAll(async () => {
  testDb = await prepareTestSchema("rooms_controller");
  process.env.PG_OPTIONS = `-c search_path=${testDb.schema}`;
  testRedis = await prepareTestRedisDb(2);
  process.env.REDIS_DB = String(testRedis.db);
  dbModule = await import("../../src/db.js");
  await dbModule.initDb(testDb.schema);
  roomsRepoModule = await import("../../src/repositories/roomsRepo.js");
  redisModule = await import("../../src/redis.js");
  await redisModule.connectRedis();
  roomsRouteModule = await import("../../src/controllers/rooms.js");

  app = express();
  app.use(express.json());
  app.use("/api/rooms", roomsRouteModule.roomsRouter);
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

    const room = await roomsRepoModule.getRoom(res.body.id);
    expect(room?.password_hash).toBeTruthy();
    expect(room?.password_hash).not.toBe("secret123");
    expect(await bcrypt.compare("secret123", room!.password_hash!)).toBe(true);
  });

  it("stores no password hash when password is omitted", async () => {
    const res = await request(app).post("/api/rooms").send({ name: "Open room" });
    const room = await roomsRepoModule.getRoom(res.body.id);
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
    const settingsModule = await import("../../src/settings.js");
    const originalMax = settingsModule.settings.maxRooms;
    const currentCount = await roomsRepoModule.countRooms();
    (settingsModule.settings as { maxRooms: number }).maxRooms = currentCount;
    try {
      const res = await request(app).post("/api/rooms").send({ name: "One too many" });
      expect(res.status).toBe(429);
    } finally {
      (settingsModule.settings as { maxRooms: number }).maxRooms = originalMax;
    }
  });

  it("allows creation again once under the cap", async () => {
    const settingsModule = await import("../../src/settings.js");
    const originalMax = settingsModule.settings.maxRooms;
    const currentCount = await roomsRepoModule.countRooms();
    (settingsModule.settings as { maxRooms: number }).maxRooms = currentCount + 1;
    try {
      const res = await request(app).post("/api/rooms").send({ name: "Just fits" });
      expect(res.status).toBe(201);
    } finally {
      (settingsModule.settings as { maxRooms: number }).maxRooms = originalMax;
    }
  });

  it("rate-limits repeated room creation from the same address", async () => {
    const settingsModule = await import("../../src/settings.js");
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
    const settingsModule = await import("../../src/settings.js");
    const lockModule = await import("../../src/lock.js");
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
