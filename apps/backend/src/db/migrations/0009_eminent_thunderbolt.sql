CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The one bootstrap user every existing row is assigned to — see db/bootstrapUser.ts. Inserted
-- before anything below references it, so the two ADD CONSTRAINT statements never see a dangling
-- foreign key.
INSERT INTO "users" ("id") VALUES ('00000000-0000-4000-8000-000000000001');
--> statement-breakpoint
-- Reuses the existing singleton's own id as its user_id, so the one real profile that exists today
-- is already the bootstrap user's the moment this rename lands — no backfill UPDATE needed here,
-- unlike applications below.
ALTER TABLE "profiles" RENAME COLUMN "id" TO "user_id";--> statement-breakpoint
DROP INDEX "applications_job_url_created_at_idx";--> statement-breakpoint
DROP INDEX "applications_job_key_created_at_idx";--> statement-breakpoint
DROP INDEX "applications_created_at_idx";--> statement-breakpoint
-- Added nullable, then backfilled, then tightened: `applications` already holds rows, and a bare
-- `ADD COLUMN ... NOT NULL` with no default fails outright against any of them.
ALTER TABLE "applications" ADD COLUMN "user_id" uuid;--> statement-breakpoint
UPDATE "applications" SET "user_id" = '00000000-0000-4000-8000-000000000001' WHERE "user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_user_job_url_created_at_idx" ON "applications" USING btree ("user_id","job_url","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "applications_user_job_key_created_at_idx" ON "applications" USING btree ("user_id","job_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "applications_user_created_at_idx" ON "applications" USING btree ("user_id","created_at" DESC NULLS LAST);
