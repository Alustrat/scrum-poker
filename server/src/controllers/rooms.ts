import { Router } from "express";
import * as roomService from "../services/roomService.js";
import { LockTimeoutError } from "../lock.js";

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

  try {
    const room = await roomService.createRoom({
      name: trimmedName,
      password: typeof password === "string" && password.length > 0 ? password : null,
      ip: req.ip ?? "unknown",
    });
    res.status(201).json({ id: room.id, name: room.name });
  } catch (err) {
    if (err instanceof roomService.RoomCreationRateLimitedError) {
      res.status(429).json({ error: err.message });
      return;
    }
    if (err instanceof roomService.RoomLimitReachedError) {
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
  const room = await roomService.getRoomById(req.params.id);
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }
  res.json({ id: room.id, name: room.name, hasPassword: !!room.password_hash });
});
