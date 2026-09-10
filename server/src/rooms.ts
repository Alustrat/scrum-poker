import { Router } from "express";
import bcrypt from "bcrypt";
import { v4 as uuid } from "uuid";
import { deleteInactiveRooms, getRoom, insertRoom } from "./db.js";
import { pubClient } from "./redis.js";
import { settings } from "./settings.js";

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

export async function joinParticipant(
  roomId: string,
  clientId: string,
  socketId: string,
  displayName: string
): Promise<void> {
  await pubClient.hSet(namesKey(roomId), clientId, displayName);
  await pubClient.sAdd(socketsKey(roomId, clientId), socketId);
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

export const roomsRouter = Router();

roomsRouter.post("/", async (req, res) => {
  const { name, password } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Room name is required" });
    return;
  }
  const passwordHash =
    typeof password === "string" && password.length > 0
      ? await bcrypt.hash(password, settings.bcryptSaltRounds)
      : null;

  const room = await insertRoom({ id: uuid(), name: name.trim(), passwordHash });
  res.status(201).json({ id: room.id, name: room.name });
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
      .catch((err) => {
        console.error("Failed to clean up inactive rooms", err);
      });
  }, settings.cleanupIntervalMs);
}
