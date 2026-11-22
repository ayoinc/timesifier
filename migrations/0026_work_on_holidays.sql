CREATE TABLE `__new_work_requests` (
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
	CONSTRAINT "work_requests_kind_known" CHECK("__new_work_requests"."kind" IN ('overtime', 'weekend', 'holiday')),
	CONSTRAINT "work_requests_status_known" CHECK("__new_work_requests"."status" IN ('pending', 'approved', 'refused', 'withdrawn', 'cancelled')),
	CONSTRAINT "work_requests_ends_on_or_after_start" CHECK("__new_work_requests"."ends_on" >= "__new_work_requests"."starts_on"),
	CONSTRAINT "work_requests_minutes_in_range" CHECK("__new_work_requests"."minutes_per_day" BETWEEN 1 AND 1440)
);
--> statement-breakpoint
INSERT INTO `__new_work_requests`("id", "organisation_id", "user_id", "kind", "starts_on", "ends_on", "minutes_per_day", "reason", "status", "decided_by", "decided_at", "comment", "created_at", "updated_at") SELECT "id", "organisation_id", "user_id", "kind", "starts_on", "ends_on", "minutes_per_day", "reason", "status", "decided_by", "decided_at", "comment", "created_at", "updated_at" FROM `work_requests`;--> statement-breakpoint
DROP TABLE `work_requests`;--> statement-breakpoint
ALTER TABLE `__new_work_requests` RENAME TO `work_requests`;--> statement-breakpoint
CREATE UNIQUE INDEX `work_requests_organisation_id_id_unique` ON `work_requests` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `work_requests_organisation_id_user_id_starts_on_idx` ON `work_requests` (`organisation_id`,`user_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `work_requests_organisation_id_status_starts_on_idx` ON `work_requests` (`organisation_id`,`status`,`starts_on`);