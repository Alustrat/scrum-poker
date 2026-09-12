import { defineConfig } from "drizzle-kit";
import { settings } from "./src/settings.js";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    host: settings.db.host,
    port: settings.db.port,
    user: settings.db.user,
    password: settings.db.password,
    database: settings.db.name,
  },
});
