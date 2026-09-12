import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { roomsRouter } from "./controllers/rooms.js";
import { startCleanupJob } from "./services/roomService.js";
import { registerSocketHandlers } from "./socket.js";
import { settings } from "./settings.js";
import { initDb } from "./db.js";
import { connectRedis } from "./redis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api/rooms", roomsRouter);

const clientDist = path.join(__dirname, "../../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: settings.clientOrigin },
});

try {
  await initDb();
} catch (err) {
  console.error(
    `Could not connect to Postgres at ${settings.db.host}:${settings.db.port}. ` +
      "Start it with: docker compose up -d postgres",
    err
  );
  process.exit(1);
}

try {
  const { pubClient, subClient } = await connectRedis();
  io.adapter(createAdapter(pubClient, subClient));
} catch (err) {
  console.error(
    `Could not connect to Redis at ${settings.redis.host}:${settings.redis.port}. ` +
      "Start it with: docker compose up -d redis",
    err
  );
  process.exit(1);
}

registerSocketHandlers(io);
startCleanupJob();

httpServer.listen(settings.port, () => {
  console.log(`Server listening on http://localhost:${settings.port}`);
});
