CREATE TABLE `notification_choices` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`email` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `kind`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`path` text NOT NULL,
	`key` text,
	`email_state` text DEFAULT 'none' NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`user_id`) REFERENCES `memberships`(`organisation_id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notifications_email_state_known" CHECK("notifications"."email_state" IN ('none', 'waiting', 'sent', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_organisation_id_id_unique` ON `notifications` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `notifications_organisation_id_user_id_created_at_idx` ON `notifications` (`organisation_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_key_unique` ON `notifications` (`organisation_id`,`user_id`,`key`) WHERE "notifications"."key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `notifications_email_waiting_idx` ON `notifications` (`created_at`) WHERE "notifications"."email_state" = 'waiting';--> statement-breakpoint
CREATE INDEX `notifications_created_at_idx` ON `notifications` (`created_at`);