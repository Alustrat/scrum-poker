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
} as const;
