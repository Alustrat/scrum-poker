import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});
