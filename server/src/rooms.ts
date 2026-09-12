import { Router } from "express";
import bcrypt from "bcrypt";
import { v4 as uuid } from "uuid";
import { countRooms, deleteInactiveRooms, getRoom, insertRoom } from "./db.js";
import { pubClient } from "./redis.js";
import { settings } from "./settings.js";
import { LockTimeoutError, withLock } from "./lock.js";

export interface Participant {
  clientId: string;
  socketIds: Set<string>;
  name: string;
  vote: string | null;
}

export interface RoomState {
  revealed: boolean;
  participants: Map<string, Participant>;
}

const namesKey = (roomId: string) => `room:${roomId}:names`;
const votesKey = (roomId: string) => `room:${roomId}:votes`;
const revealedKey = (roomId: string) => `room:${roomId}:revealed`;
const socketsKey = (roomId: string, clientId: string) => `room:${roomId}:sockets:${clientId}`;
const joinLockKey = (roomId: string) => `lock:room:${roomId}:join`;
const roomsCreateLockKey = "lock:rooms:create";

export class RoomFullError extends Error {
  constructor() {
    super("Room is full");
    this.name = "RoomFullError";
  }
}

export class TooManyConnectionsError extends Error {
  constructor() {
    super("Too many connections for this participant");
    this.name = "TooManyConnectionsError";
  }
}

export class RoomLimitReachedError extends Error {
  constructor() {
    super("Maximum number of rooms reached");
    this.name = "RoomLimitReachedError";
  }
}

export async function joinParticipant(
  roomId: string,
  clientId: string,
  socketId: string,
  displayName: string
): Promise<void> {
  await pubClient.hSet(namesKey(roomId), clientId, displayName);
  await pubClient.sAdd(socketsKey(roomId, clientId), socketId);
}

// Atomically enforces the per-room participant cap and per-participant
// connection cap before joining, so concurrent joins can't race past either
// limit (each check-then-act runs under a Redis lock scoped to the room).
export async function tryJoinParticipant(
  roomId: string,
  clientId: string,
  socketId: string,
  displayName: string
): Promise<void> {
  await withLock(joinLockKey(roomId), async () => {
    const isNewParticipant = !(await pubClient.hExists(namesKey(roomId), clientId));
    if (isNewParticipant) {
      const participantCount = await pubClient.hLen(namesKey(roomId));
      if (participantCount >= settings.maxParticipantsPerRoom) {
        throw new RoomFullError();
      }
    } else {
      const socketCount = await pubClient.sCard(socketsKey(roomId, clientId));
      if (socketCount >= settings.maxSocketsPerParticipant) {
        throw new TooManyConnectionsError();
      }
    }
    await joinParticipant(roomId, clientId, socketId, displayName);
  });
}

export async function castVote(roomId: string, clientId: string, vote: string | null): Promise<void> {
  if (vote === null) {
    await pubClient.hDel(votesKey(roomId), clientId);
  } else {
    await pubClient.hSet(votesKey(roomId), clientId, vote);
  }
}

export async function revealVotes(roomId: string): Promise<void> {
  await pubClient.set(revealedKey(roomId), "1");
}

export async function resetRound(roomId: string): Promise<void> {
  await Promise.all([pubClient.set(revealedKey(roomId), "0"), pubClient.del(votesKey(roomId))]);
}

export async function leaveSocket(roomId: string, clientId: string, socketId: string): Promise<void> {
  await pubClient.sRem(socketsKey(roomId, clientId), socketId);
  const remaining = await pubClient.sCard(socketsKey(roomId, clientId));
  if (remaining === 0) {
    await Promise.all([
      pubClient.del(socketsKey(roomId, clientId)),
      pubClient.hDel(namesKey(roomId), clientId),
      pubClient.hDel(votesKey(roomId), clientId),
    ]);
    const participantCount = await pubClient.hLen(namesKey(roomId));
    if (participantCount === 0) {
      await pubClient.del(revealedKey(roomId));
    }
  }
}

export async function getRoomState(roomId: string): Promise<RoomState> {
  const [names, votes, revealed] = await Promise.all([
    pubClient.hGetAll(namesKey(roomId)),
    pubClient.hGetAll(votesKey(roomId)),
    pubClient.get(revealedKey(roomId)),
  ]);

  const clientIds = Object.keys(names);
  let socketIdSets: string[][] = [];
  if (clientIds.length > 0) {
    const multi = pubClient.multi();
    for (const clientId of clientIds) {
      multi.sMembers(socketsKey(roomId, clientId));
    }
    socketIdSets = (await multi.exec()) as unknown as string[][];
  }

  const participants = new Map<string, Participant>();
  clientIds.forEach((clientId, i) => {
    participants.set(clientId, {
      clientId,
      name: names[clientId],
      vote: votes[clientId] ?? null,
      socketIds: new Set(socketIdSets[i]),
    });
  });

  return { revealed: revealed === "1", participants };
}

export async function roomExists(roomId: string): Promise<boolean> {
  return (await pubClient.hLen(namesKey(roomId))) > 0;
}

// Fixed-window counter kept in Redis: INCR is atomic on its own, so no lock
// is needed here the way the hard room-count cap below needs one.
async function checkRoomCreationRateLimit(ip: string): Promise<boolean> {
  const key = `ratelimit:rooms:create:${ip}`;
  const count = await pubClient.incr(key);
  if (count === 1) {
    await pubClient.pExpire(key, settings.roomCreateRateLimit.windowMs);
  }
  return count <= settings.roomCreateRateLimit.max;
}

const MAX_ROOM_NAME_LENGTH = 100;
const MAX_PASSWORD_LENGTH = 200;

export const roomsRouter = Router();

roomsRouter.post("/", async (req, res) => {
  /* v8 ignore next -- express.json() always initializes req.body to an object, even for an empty/non-JSON request */
  const { name, password } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Room name is required" });
    return;
  }
  const trimmedName = name.trim();
  if (trimmedName.length > MAX_ROOM_NAME_LENGTH) {
    res.status(400).json({ error: `Room name must be at most ${MAX_ROOM_NAME_LENGTH} characters` });
    return;
  }
  if (typeof password === "string" && password.length > MAX_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` });
    return;
  }

  const withinRateLimit = await checkRoomCreationRateLimit(req.ip ?? "unknown");
  if (!withinRateLimit) {
    res.status(429).json({ error: "Too many rooms created from this address, try again later" });
    return;
  }

  const passwordHash =
    typeof password === "string" && password.length > 0
      ? await bcrypt.hash(password, settings.bcryptSaltRounds)
      : null;

  try {
    const room = await withLock(roomsCreateLockKey, async () => {
      if ((await countRooms()) >= settings.maxRooms) {
        throw new RoomLimitReachedError();
      }
      return insertRoom({ id: uuid(), name: trimmedName, passwordHash });
    });
    res.status(201).json({ id: room.id, name: room.name });
  } catch (err) {
    if (err instanceof RoomLimitReachedError) {
      res.status(429).json({ error: "Maximum number of rooms reached, try again later" });
      return;
    }
    if (err instanceof LockTimeoutError) {
      res.status(503).json({ error: "Server is busy, try again" });
      return;
    }
    throw err;
  }
});

roomsRouter.get("/:id", async (req, res) => {
  const room = await getRoom(req.params.id);
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }
  res.json({ id: room.id, name: room.name, hasPassword: !!room.password_hash });
});

export function startCleanupJob(): NodeJS.Timeout {
  return setInterval(() => {
    deleteInactiveRooms()
      .then((deleted) => {
        if (deleted > 0) {
          console.log(`Cleaned up ${deleted} inactive room(s)`);
        }
      })
      /* v8 ignore next 3 -- defensive log for an unexpected DB failure during the background sweep */
      .catch((err) => {
        console.error("Failed to clean up inactive rooms", err);
      });
  }, settings.cleanupIntervalMs);
}
