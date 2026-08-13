ALTER TABLE "applications" ADD COLUMN "stage" text DEFAULT 'applied' NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "notes" jsonb DEFAULT '[]'::jsonb NOT NULL;