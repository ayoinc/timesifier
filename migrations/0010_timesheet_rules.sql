CREATE TABLE `work_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`minutes_per_day` integer NOT NULL,
	`reason` text,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`comment` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`user_id`) REFERENCES `memberships`(`organisation_id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "work_requests_kind_known" CHECK("work_requests"."kind" IN ('overtime', 'weekend')),
	CONSTRAINT "work_requests_status_known" CHECK("work_requests"."status" IN ('pending', 'approved', 'refused', 'withdrawn', 'cancelled')),
	CONSTRAINT "work_requests_ends_on_or_after_start" CHECK("work_requests"."ends_on" >= "work_requests"."starts_on"),
	CONSTRAINT "work_requests_minutes_in_range" CHECK("work_requests"."minutes_per_day" BETWEEN 1 AND 1440)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_requests_organisation_id_id_unique` ON `work_requests` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `work_requests_organisation_id_user_id_starts_on_idx` ON `work_requests` (`organisation_id`,`user_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `work_requests_organisation_id_status_starts_on_idx` ON `work_requests` (`organisation_id`,`status`,`starts_on`);--> statement-breakpoint
ALTER TABLE `leave_requests` ADD `notice_days` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `leave_requests` ADD `short_notice` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `leave_requests` ADD `notice_reason` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `overtime_rule` text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `weekend_rule` text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `short_notice` text DEFAULT 'with-reason' NOT NULL;
--> statement-breakpoint
-- Written by hand from here: drizzle-kit has no notation for rows.
--
-- Notice for leave (TS-090). A request made before this migration is given
-- the notice it gave, counted in UTC as its zone was not kept, and is not
-- marked short: no notice was asked then. Each kind's notice comes from
-- `0009_leave_notice`.
UPDATE `leave_requests` SET `notice_days` = CAST(julianday(`starts_on`) - julianday(date(`created_at` / 1000, 'unixepoch')) AS INTEGER);
