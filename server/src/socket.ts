import type { Server, Socket } from "socket.io";
import bcrypt from "bcrypt";
import { getRoom, touchRoom } from "./db.js";
import { LockTimeoutError } from "./lock.js";
import { settings } from "./settings.js";
import {
  castVote,
  getRoomState,
  leaveSocket,
  resetRound,
  revealVotes,
  RoomFullError,
  TooManyConnectionsError,
  tryJoinParticipant,
  type RoomState,
} from "./rooms.js";

interface JoinAuth {
  roomId: string;
  password?: string;
  displayName: string;
  clientId: string;
}

interface SocketData {
  roomId: string;
  displayName: string;
  clientId: string;
}

function serializeParticipant(
  p: { clientId: string; name: string; vote: string | null },
  opts: { revealed: boolean; viewerClientId: string }
) {
  const voted = p.vote !== null;
  const showValue = opts.revealed || p.clientId === opts.viewerClientId;
  return {
    id: p.clientId,
    name: p.name,
    voted,
    vote: showValue ? p.vote : null,
  };
}

function emitRoomState(io: Server, roomId: string, state: RoomState) {
  for (const viewer of state.participants.values()) {
    const payload = {
      revealed: state.revealed,
      participants: [...state.participants.values()].map((p) =>
        serializeParticipant(p, { revealed: state.revealed, viewerClientId: viewer.clientId })
      ),
    };
    for (const socketId of viewer.socketIds) {
      io.to(socketId).emit("room:state", payload);
    }
  }
}

const MAX_DISPLAY_NAME_LENGTH = 50;

export function registerSocketHandlers(io: Server) {
  io.use(async (socket: Socket, next) => {
    const auth = socket.handshake.auth as Partial<JoinAuth>;
    const roomId = auth.roomId;
    const displayName = auth.displayName?.trim();
    const clientId = auth.clientId;

    if (!roomId || !displayName || !clientId) {
      next(new Error("roomId, displayName and clientId are required"));
      return;
    }

    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      next(new Error(`Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`));
      return;
    }

    const room = await getRoom(roomId);
    if (!room) {
      next(new Error("Room not found"));
      return;
    }

    if (room.password_hash) {
      const password = auth.password ?? "";
      const valid = await bcrypt.compare(password, room.password_hash);
      if (!valid) {
        next(new Error("Invalid password"));
        return;
      }
    }

    try {
      await tryJoinParticipant(roomId, clientId, socket.id, displayName);
    } catch (err) {
      if (err instanceof RoomFullError) {
        next(new Error("Room is full"));
        return;
      }
      if (err instanceof TooManyConnectionsError) {
        next(new Error("Too many connections for this participant"));
        return;
      }
      if (err instanceof LockTimeoutError) {
        next(new Error("Server is busy, try again"));
        return;
      }
      next(err instanceof Error ? err : new Error("Failed to join room"));
      return;
    }

    (socket.data as SocketData).roomId = roomId;
    (socket.data as SocketData).displayName = displayName;
    (socket.data as SocketData).clientId = clientId;
    next();
  });

  io.on("connection", async (socket: Socket) => {
    const { roomId, clientId } = socket.data as SocketData;

    socket.join(roomId);
    touchRoom(roomId).catch((err) => console.error("Failed to update room activity", err));
    emitRoomState(io, roomId, await getRoomState(roomId));

    socket.on("vote:cast", async (value: unknown) => {
      if (value !== null && (typeof value !== "string" || !settings.allowedVotes.includes(value))) return;
      await castVote(roomId, clientId, value);
      touchRoom(roomId).catch((err) => console.error("Failed to update room activity", err));
      emitRoomState(io, roomId, await getRoomState(roomId));
    });

    socket.on("votes:reveal", async () => {
      await revealVotes(roomId);
      touchRoom(roomId).catch((err) => console.error("Failed to update room activity", err));
      emitRoomState(io, roomId, await getRoomState(roomId));
    });

    socket.on("round:reset", async () => {
      await resetRound(roomId);
      touchRoom(roomId).catch((err) => console.error("Failed to update room activity", err));
      emitRoomState(io, roomId, await getRoomState(roomId));
    });

    socket.on("disconnect", async () => {
      await leaveSocket(roomId, clientId, socket.id);
      const state = await getRoomState(roomId);
      if (state.participants.size > 0) {
        emitRoomState(io, roomId, state);
      }
    });
  });
}
