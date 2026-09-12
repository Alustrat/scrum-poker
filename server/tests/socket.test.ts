import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import bcrypt from "bcrypt";
import { v4 as uuid } from "uuid";
import { prepareTestSchema, type TestDbHandle } from "./pg-test-helper.js";
import { prepareTestRedisDb, type TestRedisHandle } from "./redis-test-helper.js";

interface StateParticipant {
  id: string;
  name: string;
  voted: boolean;
  vote: string | null;
}

interface RoomStatePayload {
  revealed: boolean;
  participants: StateParticipant[];
}

let testDb: TestDbHandle;
let testRedis: TestRedisHandle;
let dbModule: typeof import("../src/db.js");
let redisModule: typeof import("../src/redis.js");
let roomsModule: typeof import("../src/rooms.js");
let socketModule: typeof import("../src/socket.js");
let httpServer: ReturnType<typeof createServer>;
let io: Server;
let baseUrl: string;

let passwordRoomId: string;
const roomPassword = "hunter2";

const clients: ClientSocket[] = [];

beforeAll(async () => {
  testDb = await prepareTestSchema("socket");
  process.env.PG_OPTIONS = `-c search_path=${testDb.schema}`;
  testRedis = await prepareTestRedisDb(3);
  process.env.REDIS_DB = String(testRedis.db);
  dbModule = await import("../src/db.js");
  await dbModule.initDb(testDb.schema);
  redisModule = await import("../src/redis.js");
  await redisModule.connectRedis();
  roomsModule = await import("../src/rooms.js");
  socketModule = await import("../src/socket.js");

  passwordRoomId = uuid();
  const passwordHash = await bcrypt.hash(roomPassword, 4);
  await dbModule.insertRoom({ id: passwordRoomId, name: "Locked Room", passwordHash });

  httpServer = createServer();
  io = new Server(httpServer, { cors: { origin: "*" } });
  socketModule.registerSocketHandlers(io);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await dbModule.pool.end();
  await testDb.dropSchema();
  await redisModule.pubClient.quit();
  await redisModule.subClient.quit();
  await testRedis.flush();
});

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
});

function connectClient(auth: Record<string, unknown>): ClientSocket {
  const client = ioClient(baseUrl, {
    auth,
    reconnection: false,
    forceNew: true,
  });
  clients.push(client);
  return client;
}

function waitForConnect(client: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("connect_error", (err) => reject(err));
  });
}

function waitForConnectError(client: ClientSocket): Promise<Error> {
  return new Promise((resolve) => {
    client.once("connect_error", (err) => resolve(err));
  });
}

function waitForState(
  client: ClientSocket,
  predicate: (state: RoomStatePayload) => boolean
): Promise<RoomStatePayload> {
  return new Promise((resolve) => {
    const handler = (state: RoomStatePayload) => {
      if (predicate(state)) {
        client.off("room:state", handler);
        resolve(state);
      }
    };
    client.on("room:state", handler);
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function participant(state: RoomStatePayload, clientId: string): StateParticipant | undefined {
  return state.participants.find((p) => p.id === clientId);
}

describe("connection auth", () => {
  it("rejects a connection missing roomId/displayName/clientId", async () => {
    const client = connectClient({});
    const err = await waitForConnectError(client);
    expect(err.message).toMatch(/roomId, displayName and clientId are required/);
  });

  it("rejects a connection to a nonexistent room", async () => {
    const client = connectClient({ roomId: uuid(), displayName: "Nobody", clientId: uuid() });
    const err = await waitForConnectError(client);
    expect(err.message).toBe("Room not found");
  });

  it("rejects a wrong password for a protected room", async () => {
    const client = connectClient({
      roomId: passwordRoomId,
      displayName: "Eve",
      clientId: uuid(),
      password: "wrong",
    });
    const err = await waitForConnectError(client);
    expect(err.message).toBe("Invalid password");
  });

  it("rejects a missing password for a protected room", async () => {
    const client = connectClient({
      roomId: passwordRoomId,
      displayName: "Eve",
      clientId: uuid(),
    });
    const err = await waitForConnectError(client);
    expect(err.message).toBe("Invalid password");
  });

  it("accepts the correct password for a protected room", async () => {
    const client = connectClient({
      roomId: passwordRoomId,
      displayName: "Alice",
      clientId: uuid(),
      password: roomPassword,
    });
    await expect(waitForConnect(client)).resolves.toBeUndefined();
  });
});

describe("capacity limits", () => {
  it("rejects a new connection once the room is at its participant cap", async () => {
    const settingsModule = await import("../src/settings.js");
    const originalMax = settingsModule.settings.maxParticipantsPerRoom;
    (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom = 2;
    try {
      const roomId = uuid();
      await dbModule.insertRoom({ id: roomId, name: "Tiny Room", passwordHash: null });

      const first = connectClient({ roomId, displayName: "A", clientId: uuid() });
      await waitForConnect(first);
      const second = connectClient({ roomId, displayName: "B", clientId: uuid() });
      await waitForConnect(second);

      const third = connectClient({ roomId, displayName: "C", clientId: uuid() });
      const err = await waitForConnectError(third);
      expect(err.message).toBe("Room is full");
    } finally {
      (settingsModule.settings as { maxParticipantsPerRoom: number }).maxParticipantsPerRoom =
        originalMax;
    }
  });

  it("rejects an extra socket for the same participant once past the per-participant socket cap", async () => {
    const settingsModule = await import("../src/settings.js");
    const originalMax = settingsModule.settings.maxSocketsPerParticipant;
    (settingsModule.settings as { maxSocketsPerParticipant: number }).maxSocketsPerParticipant = 1;
    try {
      const roomId = uuid();
      await dbModule.insertRoom({ id: roomId, name: "One Tab Room", passwordHash: null });
      const clientId = uuid();

      const tab1 = connectClient({ roomId, displayName: "Solo", clientId });
      await waitForConnect(tab1);

      const tab2 = connectClient({ roomId, displayName: "Solo", clientId });
      const err = await waitForConnectError(tab2);
      expect(err.message).toBe("Too many connections for this participant");
    } finally {
      (settingsModule.settings as { maxSocketsPerParticipant: number }).maxSocketsPerParticipant =
        originalMax;
    }
  });

  it("rejects a connection with a 'server is busy' error when the join lock can't be acquired", async () => {
    const settingsModule = await import("../src/settings.js");
    const lockModule = await import("../src/lock.js");
    const originalMaxWaitMs = settingsModule.settings.lock.maxWaitMs;
    (settingsModule.settings as { lock: { maxWaitMs: number } }).lock.maxWaitMs = 50;

    const roomId = uuid();
    await dbModule.insertRoom({ id: roomId, name: "Contended Room", passwordHash: null });
    const holderToken = await lockModule.acquireLock(`lock:room:${roomId}:join`, { ttlMs: 5000 });
    try {
      const client = connectClient({ roomId, displayName: "Anyone", clientId: uuid() });
      const err = await waitForConnectError(client);
      expect(err.message).toBe("Server is busy, try again");
    } finally {
      await lockModule.releaseLock(`lock:room:${roomId}:join`, holderToken!);
      (settingsModule.settings as { lock: { maxWaitMs: number } }).lock.maxWaitMs =
        originalMaxWaitMs;
    }
  });

  it("rejects a display name over the max length", async () => {
    const roomId = uuid();
    await dbModule.insertRoom({ id: roomId, name: "Name Cap Room", passwordHash: null });
    const client = connectClient({
      roomId,
      displayName: "x".repeat(51),
      clientId: uuid(),
    });
    const err = await waitForConnectError(client);
    expect(err.message).toMatch(/Display name must be at most/);
  });
});

describe("joining a room", () => {
  it("emits room:state with the joining participant", async () => {
    const roomId = uuid();
    await dbModule.insertRoom({ id: roomId, name: "Fresh Room", passwordHash: null });
    const clientId = uuid();
    const client = connectClient({ roomId, displayName: "Alice", clientId });

    const state = await waitForState(client, (s) => s.participants.length === 1);
    expect(state.revealed).toBe(false);
    expect(state.participants[0]).toEqual({
      id: clientId,
      name: "Alice",
      voted: false,
      vote: null,
    });
  });
});

describe("voting flow", () => {
  it("hides other participants' votes until reveal, then reveal and reset work", async () => {
    const roomId = uuid();
    await dbModule.insertRoom({ id: roomId, name: "Voting Room", passwordHash: null });

    const aliceId = uuid();
    const bobId = uuid();
    const alice = connectClient({ roomId, displayName: "Alice", clientId: aliceId });
    await waitForState(alice, (s) => s.participants.length === 1);

    const bob = connectClient({ roomId, displayName: "Bob", clientId: bobId });
    await Promise.all([
      waitForState(alice, (s) => s.participants.length === 2),
      waitForState(bob, (s) => s.participants.length === 2),
    ]);

    alice.emit("vote:cast", "5");
    const aliceOwnState = await waitForState(
      alice,
      (s) => participant(s, aliceId)?.voted === true
    );
    expect(participant(aliceOwnState, aliceId)).toMatchObject({ voted: true, vote: "5" });

    const bobViewOfAlice = await waitForState(bob, (s) => participant(s, aliceId)?.voted === true);
    expect(participant(bobViewOfAlice, aliceId)).toMatchObject({ voted: true, vote: null });

    bob.emit("vote:cast", "8");
    await waitForState(bob, (s) => participant(s, bobId)?.voted === true);

    bob.emit("vote:cast", 42);
    bob.emit("vote:cast", "not-a-real-card");
    // Neither the wrong-type nor the off-deck value is a legit "room:state" trigger,
    // so poll the store directly rather than waiting on an event that won't fire.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const bobVoteAfterInvalidAttempts = (await roomsModule.getRoomState(roomId)).participants.get(
      bobId
    )?.vote;
    expect(bobVoteAfterInvalidAttempts).toBe("8");

    alice.emit("votes:reveal");
    const aliceRevealed = await waitForState(alice, (s) => s.revealed === true);
    expect(participant(aliceRevealed, aliceId)?.vote).toBe("5");
    expect(participant(aliceRevealed, bobId)?.vote).toBe("8");

    const bobRevealed = await waitForState(bob, (s) => s.revealed === true);
    expect(participant(bobRevealed, aliceId)?.vote).toBe("5");
    expect(participant(bobRevealed, bobId)?.vote).toBe("8");

    bob.emit("round:reset");
    const resetState = await waitForState(alice, (s) => s.revealed === false);
    expect(resetState.participants.every((p) => p.voted === false && p.vote === null)).toBe(true);
  });
});

describe("multi-tab reconnect and disconnect cleanup", () => {
  it("keeps one participant across two sockets sharing a clientId, and cleans up on full disconnect", async () => {
    const roomId = uuid();
    await dbModule.insertRoom({ id: roomId, name: "Multi Tab Room", passwordHash: null });
    const clientId = uuid();

    const tab1 = connectClient({ roomId, displayName: "Carol", clientId });
    await waitForState(tab1, (s) => s.participants.length === 1);

    const tab2 = connectClient({ roomId, displayName: "Carol", clientId });
    await Promise.all([
      waitForState(tab1, (s) => s.participants.length === 1),
      waitForState(tab2, (s) => s.participants.length === 1),
    ]);

    tab1.disconnect();
    await waitForState(tab2, (s) => s.participants.length === 1);
    expect(await roomsModule.roomExists(roomId)).toBe(true);

    tab2.disconnect();
    await waitUntil(async () => !(await roomsModule.roomExists(roomId)));
  });
});
