ALTER TABLE "applications" ADD COLUMN "raw_description" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "extraction_version" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "requirement_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "bullet_provenance" jsonb;