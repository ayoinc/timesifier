CREATE TABLE `__new_period_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`period_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text,
	`comment` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`period_id`) REFERENCES `periods`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "period_events_action_known" CHECK("__new_period_events"."action" IN ('submitted', 'withdrawn', 'approved', 'returned', 'reopened'))
);
--> statement-breakpoint
INSERT INTO `__new_period_events`("id", "organisation_id", "period_id", "action", "actor_id", "comment", "created_at") SELECT "id", "organisation_id", "period_id", "action", "actor_id", "comment", "created_at" FROM `period_events`;--> statement-breakpoint
DROP TABLE `period_events`;--> statement-breakpoint
ALTER TABLE `__new_period_events` RENAME TO `period_events`;--> statement-breakpoint
CREATE INDEX `period_events_organisation_id_period_id_idx` ON `period_events` (`organisation_id`,`period_id`);--> statement-breakpoint
ALTER TABLE `organisations` ADD `lock_reason` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `auto_submit_at_lock` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `auto_locked_through` text;