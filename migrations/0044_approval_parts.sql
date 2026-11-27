-- TS-117, decision 79: approval by project. A submitted week with time on a
-- client project that has a delivery manager is held in parts, each decided
-- apart; the period's own status follows them. Period events say which part
-- a step was taken on. Only adds a table and two columns: a period with no
-- parts, every period before this, is decided whole as before.
CREATE TABLE `period_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`period_id` text NOT NULL,
	`project_id` text,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`comment` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organisation_id`,`period_id`) REFERENCES `periods`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "period_parts_status_known" CHECK("period_parts"."status" IN ('submitted', 'approved', 'returned'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `period_parts_organisation_id_id_unique` ON `period_parts` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `period_parts_period_id_project_id_unique` ON `period_parts` (`period_id`,`project_id`) WHERE "period_parts"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `period_parts_period_id_line_unique` ON `period_parts` (`period_id`) WHERE "period_parts"."project_id" IS NULL;--> statement-breakpoint
CREATE INDEX `period_parts_organisation_id_period_id_idx` ON `period_parts` (`organisation_id`,`period_id`);--> statement-breakpoint
CREATE INDEX `period_parts_waiting_idx` ON `period_parts` (`organisation_id`,`project_id`) WHERE "period_parts"."status" = 'submitted';--> statement-breakpoint
ALTER TABLE `period_events` ADD `part` text DEFAULT 'week' NOT NULL;--> statement-breakpoint
ALTER TABLE `period_events` ADD `project_id` text;