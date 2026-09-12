import bcrypt from "bcrypt";
import { v4 as uuid } from "uuid";
import {
  countRooms,
  deleteInactiveRooms,
  getRoom,
  insertRoom,
  touchRoom,
  type RoomRow,
} from "../repositories/roomsRepo.js";
import { settings } from "../settings.js";
import { withLock } from "../lock.js";
import * as roomStateRepo from "../repositories/roomStateRepo.js";
import { incrementFixedWindow } from "../repositories/rateLimitRepo.js";

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

export class RoomCreationRateLimitedError extends Error {
  constructor() {
    super("Too many rooms created from this address, try again later");
    this.name = "RoomCreationRateLimitedError";
  }
}

export async function getRoomById(id: string): Promise<RoomRow | undefined> {
  return getRoom(id);
}

export async function touchRoomActivity(id: string): Promise<void> {
  await touchRoom(id);
}

export async function verifyPassword(room: RoomRow, password: string | undefined): Promise<boolean> {
  if (!room.password_hash) return true;
  return bcrypt.compare(password ?? "", room.password_hash);
}

export async function joinParticipant(
  roomId: string,
  clientId: string,
  socketId: string,
  displayName: string
): Promise<void> {
  await roomStateRepo.addParticipant(roomId, clientId, socketId, displayName);
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
    const isNewParticipant = !(await roomStateRepo.participantExists(roomId, clientId));
    if (isNewParticipant) {
      const count = await roomStateRepo.participantCount(roomId);
      if (count >= settings.maxParticipantsPerRoom) {
        throw new RoomFullError();
      }
    } else {
      const count = await roomStateRepo.socketCount(roomId, clientId);
      if (count >= settings.maxSocketsPerParticipant) {
        throw new TooManyConnectionsError();
      }
    }
    await joinParticipant(roomId, clientId, socketId, displayName);
  });
}

export async function castVote(roomId: string, clientId: string, vote: string | null): Promise<void> {
  await roomStateRepo.setVote(roomId, clientId, vote);
}

export async function revealVotes(roomId: string): Promise<void> {
  await roomStateRepo.setRevealed(roomId, true);
}

export async function resetRound(roomId: string): Promise<void> {
  await Promise.all([roomStateRepo.setRevealed(roomId, false), roomStateRepo.clearVotes(roomId)]);
}

export async function leaveSocket(roomId: string, clientId: string, socketId: string): Promise<void> {
  const remaining = await roomStateRepo.removeSocket(roomId, clientId, socketId);
  if (remaining === 0) {
    await roomStateRepo.removeParticipant(roomId, clientId);
    const participantCount = await roomStateRepo.participantCount(roomId);
    if (participantCount === 0) {
      await roomStateRepo.clearRevealed(roomId);
    }
  }
}

export async function getRoomState(roomId: string): Promise<RoomState> {
  const { names, votes, revealed } = await roomStateRepo.getRoomHashes(roomId);
  const clientIds = Object.keys(names);
  const socketIdSets = await roomStateRepo.getSocketIdSets(roomId, clientIds);

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
  return (await roomStateRepo.participantCount(roomId)) > 0;
}

// Fixed-window counter kept in Redis via rateLimitRepo.
async function checkRoomCreationRateLimit(ip: string): Promise<boolean> {
  const key = `ratelimit:rooms:create:${ip}`;
  const count = await incrementFixedWindow(key, settings.roomCreateRateLimit.windowMs);
  return count <= settings.roomCreateRateLimit.max;
}

export async function createRoom(params: {
  name: string;
  password: string | null;
  ip: string;
}): Promise<RoomRow> {
  const withinRateLimit = await checkRoomCreationRateLimit(params.ip);
  if (!withinRateLimit) {
    throw new RoomCreationRateLimitedError();
  }

  const passwordHash = params.password
    ? await bcrypt.hash(params.password, settings.bcryptSaltRounds)
    : null;

  return withLock(roomsCreateLockKey, async () => {
    if ((await countRooms()) >= settings.maxRooms) {
      throw new RoomLimitReachedError();
    }
    return insertRoom({ id: uuid(), name: params.name, passwordHash });
  });
}

export async function cleanupInactiveRooms(): Promise<number> {
  return deleteInactiveRooms();
}

export function startCleanupJob(): NodeJS.Timeout {
  return setInterval(() => {
    cleanupInactiveRooms()
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
