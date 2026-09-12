export const settings = {
  port: process.env.PORT ? Number(process.env.PORT) : 3001,
  db: {
    host: process.env.PG_HOST ?? "localhost",
    port: process.env.PG_PORT ? Number(process.env.PG_PORT) : 5432,
    user: process.env.PG_USER ?? "postgres",
    password: process.env.PG_PASSWORD ?? "postgres",
    name: process.env.PG_DATABASE ?? "scrum_poker",
    options: process.env.PG_OPTIONS,
  },
  redis: {
    host: process.env.REDIS_HOST ?? "localhost",
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: process.env.REDIS_DB ? Number(process.env.REDIS_DB) : 0,
  },
  clientOrigin: process.env.CLIENT_ORIGIN ?? "*",
  bcryptSaltRounds: 10,
  roomInactivityMs: 15 * 24 * 60 * 60 * 1000, // 15 days
  cleanupIntervalMs: 60 * 60 * 1000, // 1 hour

  // Abuse / capacity limits
  maxRooms: process.env.MAX_ROOMS ? Number(process.env.MAX_ROOMS) : 1000,
  maxParticipantsPerRoom: process.env.MAX_PARTICIPANTS_PER_ROOM
    ? Number(process.env.MAX_PARTICIPANTS_PER_ROOM)
    : 20,
  maxSocketsPerParticipant: process.env.MAX_SOCKETS_PER_PARTICIPANT
    ? Number(process.env.MAX_SOCKETS_PER_PARTICIPANT)
    : 5,
  allowedVotes: ["0", "1", "2", "3", "5", "8", "13", "21", "?", "☕"] as string[],
  roomCreateRateLimit: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: process.env.MAX_ROOM_CREATIONS_PER_HOUR
      ? Number(process.env.MAX_ROOM_CREATIONS_PER_HOUR)
      : 20,
  },
  lock: {
    ttlMs: 5000,
    maxWaitMs: 3000,
  },
} as const;
