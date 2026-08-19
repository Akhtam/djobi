LOCK TABLE "profiles" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DELETE FROM "profiles"
WHERE "id" NOT IN (
	SELECT "id"
	FROM "profiles"
	ORDER BY "updated_at" DESC, "id" DESC
	LIMIT 1
);
--> statement-breakpoint
UPDATE "profiles"
SET "id" = '00000000-0000-4000-8000-000000000001'
WHERE "id" <> '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "id" DROP DEFAULT;
