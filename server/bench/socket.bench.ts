import { bench, describe, vi } from "vitest";
import type { Server, Socket } from "socket.io";
import { insertRoom } from "../src/repositories/roomsRepo.js";
import { registerSocketHandlers } from "../src/socket.js";

vi.mock("../src/redis.js", async () => {
  const { createFakeRedis } = await import("./fakes.js");
  const pubClient = createFakeRedis();
  return { pubClient, subClient: pubClient, connectRedis: async () => ({ pubClient, subClient: pubClient }) };
});

vi.mock("../src/repositories/roomsRepo.js", async () => {
  const { createFakeRoomsRepo } = await import("./fakes.js");
  return createFakeRoomsRepo();
});

type Handler = (...args: unknown[]) => unknown;
type Middleware = (socket: Socket, next: (err?: Error) => void) => unknown;

// Minimal Socket.IO server double: records the registered middleware and
// connection handler, and counts emitted room:state payloads.
function createFakeIo() {
  const middlewares: Middleware[] = [];
  const connectionHandlers: Handler[] = [];
  let emitted = 0;
  const target = {
    emit: () => {
      emitted++;
      return true;
    },
  };
  const io = {
    use: (fn: Middleware) => middlewares.push(fn),
    on: (event: string, fn: Handler) => {
      if (event === "connection") connectionHandlers.push(fn);
    },
    to: () => target,
  };
  return { io: io as unknown as Server, middlewares, connectionHandlers, emittedCount: () => emitted };
}

function createFakeSocket(id: string, auth: Record<string, string>) {
  const handlers = new Map<string, Handler>();
  const socket = {
    id,
    handshake: { auth },
    data: {},
    join: () => {},
    on: (event: string, fn: Handler) => handlers.set(event, fn),
  };
  return { socket: socket as unknown as Socket, handlers };
}

const ROOM_ID = "bench-room";
const PARTICIPANTS = 20;
const VOTES = ["0", "1", "2", "3", "5", "8", "13", "21", "?", "☕"];

const fake = createFakeIo();
const sockets: Array<ReturnType<typeof createFakeSocket>> = [];

async function connect(socketId: string, clientId: string, displayName: string) {
  const client = createFakeSocket(socketId, { roomId: ROOM_ID, clientId, displayName });
  for (const middleware of fake.middlewares) {
    await new Promise<void>((resolve, reject) =>
      middleware(client.socket, (err) => (err ? reject(err) : resolve()))
    );
  }
  for (const handler of fake.connectionHandlers) {
    await handler(client.socket);
  }
  return client;
}

// Set up at module load: vitest bench does not run beforeAll hooks.
registerSocketHandlers(fake.io);
await insertRoom({ id: ROOM_ID, name: "Benchmark room", passwordHash: null });
for (let i = 0; i < PARTICIPANTS; i++) {
  sockets.push(await connect(`socket-${i}`, `client-${i}`, `Participant ${i}`));
}
if (fake.emittedCount() === 0) {
  throw new Error("socket benchmark setup failed: no room:state was emitted");
}

describe("socket handlers - 20 participant room", () => {
  let voteIndex = 0;
  bench("vote:cast - broadcast room state to every participant", async () => {
    const i = voteIndex++ % PARTICIPANTS;
    await sockets[i].handlers.get("vote:cast")!(VOTES[voteIndex % VOTES.length]);
  });

  bench("votes:reveal + round:reset", async () => {
    await sockets[0].handlers.get("votes:reveal")!();
    await sockets[0].handlers.get("round:reset")!();
  });

  let extraSocket = 0;
  bench("connect + disconnect an extra tab", async () => {
    const client = await connect(`extra-${extraSocket++}`, "client-0", "Participant 0");
    await client.handlers.get("disconnect")!();
  });
});
