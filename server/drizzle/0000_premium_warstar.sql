CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"created_at" bigint NOT NULL,
	"last_activity_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_rooms_last_activity" ON "rooms" USING btree ("last_activity_at");