import { pubClient } from "../redis.js";

const namesKey = (roomId: string) => `room:${roomId}:names`;
const votesKey = (roomId: string) => `room:${roomId}:votes`;
const revealedKey = (roomId: string) => `room:${roomId}:revealed`;
const socketsKey = (roomId: string, clientId: string) => `room:${roomId}:sockets:${clientId}`;

export interface RawRoomState {
  names: Record<string, string>;
  votes: Record<string, string>;
  revealed: string | null;
}

export async function addParticipant(
  roomId: string,
  clientId: string,
  socketId: string,
  displayName: string
): Promise<void> {
  await pubClient.hSet(namesKey(roomId), clientId, displayName);
  await pubClient.sAdd(socketsKey(roomId, clientId), socketId);
}

export async function participantExists(roomId: string, clientId: string): Promise<boolean> {
  return Boolean(await pubClient.hExists(namesKey(roomId), clientId));
}

export async function participantCount(roomId: string): Promise<number> {
  return pubClient.hLen(namesKey(roomId));
}

export async function socketCount(roomId: string, clientId: string): Promise<number> {
  return pubClient.sCard(socketsKey(roomId, clientId));
}

export async function setVote(roomId: string, clientId: string, vote: string | null): Promise<void> {
  if (vote === null) {
    await pubClient.hDel(votesKey(roomId), clientId);
  } else {
    await pubClient.hSet(votesKey(roomId), clientId, vote);
  }
}

export async function setRevealed(roomId: string, revealed: boolean): Promise<void> {
  await pubClient.set(revealedKey(roomId), revealed ? "1" : "0");
}

export async function clearVotes(roomId: string): Promise<void> {
  await pubClient.del(votesKey(roomId));
}

// Returns the remaining socket count for this participant after removal, so
// the caller can decide whether to tear the participant down entirely.
export async function removeSocket(roomId: string, clientId: string, socketId: string): Promise<number> {
  await pubClient.sRem(socketsKey(roomId, clientId), socketId);
  return pubClient.sCard(socketsKey(roomId, clientId));
}

export async function removeParticipant(roomId: string, clientId: string): Promise<void> {
  await Promise.all([
    pubClient.del(socketsKey(roomId, clientId)),
    pubClient.hDel(namesKey(roomId), clientId),
    pubClient.hDel(votesKey(roomId), clientId),
  ]);
}

export async function clearRevealed(roomId: string): Promise<void> {
  await pubClient.del(revealedKey(roomId));
}

export async function getRoomHashes(roomId: string): Promise<RawRoomState> {
  const [names, votes, revealed] = await Promise.all([
    pubClient.hGetAll(namesKey(roomId)),
    pubClient.hGetAll(votesKey(roomId)),
    pubClient.get(revealedKey(roomId)),
  ]);
  return { names, votes, revealed };
}

export async function getSocketIdSets(roomId: string, clientIds: string[]): Promise<string[][]> {
  if (clientIds.length === 0) return [];
  const multi = pubClient.multi();
  for (const clientId of clientIds) {
    multi.sMembers(socketsKey(roomId, clientId));
  }
  return (await multi.exec()) as unknown as string[][];
}
