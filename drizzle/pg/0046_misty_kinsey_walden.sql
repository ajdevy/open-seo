ALTER TABLE "ai_trackers" ADD COLUMN "schedule_weekday" integer;--> statement-breakpoint
ALTER TABLE "ai_trackers" ADD COLUMN "schedule_hour" integer;--> statement-breakpoint
ALTER TABLE "ai_trackers" ADD COLUMN "schedule_minute" integer;--> statement-breakpoint
ALTER TABLE "ai_trackers" ADD COLUMN "schedule_time_zone" text;