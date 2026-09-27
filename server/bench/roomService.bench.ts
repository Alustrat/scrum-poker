import { bench, describe, vi } from "vitest";
import { pubClient } from "../src/redis.js";
import * as roomService from "../src/services/roomService.js";

vi.mock("../src/redis.js", async () => {
  const { createFakeRedis } = await import("./fakes.js");
  const pubClient = createFakeRedis();
  return { pubClient, subClient: pubClient, connectRedis: async () => ({ pubClient, subClient: pubClient }) };
});

vi.mock("../src/repositories/roomsRepo.js", async () => {
  const { createFakeRoomsRepo } = await import("./fakes.js");
  return createFakeRoomsRepo();
});

const fakeRedis = pubClient as unknown as ReturnType<typeof import("./fakes.js").createFakeRedis>;
const VOTES = ["0", "1", "2", "3", "5", "8", "13", "21", "?", "☕"];

async function seedRoom(roomId: string, participants: number, socketsPerParticipant = 1) {
  for (let i = 0; i < participants; i++) {
    const clientId = `client-${i}`;
    for (let s = 0; s < socketsPerParticipant; s++) {
      await roomService.joinParticipant(roomId, clientId, `socket-${i}-${s}`, `Participant ${i}`);
    }
    await roomService.castVote(roomId, clientId, VOTES[i % VOTES.length]);
  }
  await roomService.revealVotes(roomId);
}

// Seeded at module load: vitest bench does not run beforeAll hooks.
fakeRedis.flushAll();
await seedRoom("room-small", 5);
await seedRoom("room-full", 20, 3);

describe("roomService", () => {
  bench("getRoomState - 5 participants", async () => {
    await roomService.getRoomState("room-small");
  });

  bench("getRoomState - 20 participants x 3 sockets", async () => {
    await roomService.getRoomState("room-full");
  });

  bench("tryJoinParticipant + leaveSocket - fill and empty a room", async () => {
    const roomId = "room-churn";
    for (let i = 0; i < 20; i++) {
      await roomService.tryJoinParticipant(roomId, `client-${i}`, `socket-${i}`, `Participant ${i}`);
    }
    for (let i = 0; i < 20; i++) {
      await roomService.leaveSocket(roomId, `client-${i}`, `socket-${i}`);
    }
  });

  bench("voting round - 20 votes, reveal, reset", async () => {
    const roomId = "room-full";
    for (let i = 0; i < 20; i++) {
      await roomService.castVote(roomId, `client-${i}`, VOTES[(i * 3) % VOTES.length]);
    }
    await roomService.revealVotes(roomId);
    await roomService.resetRound(roomId);
  });
});
