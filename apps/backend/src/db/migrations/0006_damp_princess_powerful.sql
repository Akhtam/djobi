ALTER TABLE "applications" ADD COLUMN "job_key" text;--> statement-breakpoint
CREATE INDEX "applications_job_key_created_at_idx" ON "applications" USING btree ("job_key","created_at" DESC NULLS LAST);