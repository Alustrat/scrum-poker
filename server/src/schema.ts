import { pgTable, text, bigint, index } from "drizzle-orm/pg-core";

export const rooms = pgTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    password_hash: text("password_hash"),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    last_activity_at: bigint("last_activity_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_rooms_last_activity").on(table.last_activity_at)]
);
