CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_organisation_id_id_unique` ON `clients` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `clients_organisation_id_name_key_unique` ON `clients` (`organisation_id`,`name_key`);--> statement-breakpoint
CREATE TABLE `period_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`period_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`comment` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`period_id`) REFERENCES `periods`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "period_events_action_known" CHECK("period_events"."action" IN ('submitted', 'withdrawn', 'approved', 'returned', 'reopened'))
);
--> statement-breakpoint
CREATE INDEX `period_events_organisation_id_period_id_idx` ON `period_events` (`organisation_id`,`period_id`);--> statement-breakpoint
CREATE TABLE `periods` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`status` text NOT NULL,
	`submitted_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`comment` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "periods_status_known" CHECK("periods"."status" IN ('submitted', 'withdrawn', 'approved', 'returned')),
	CONSTRAINT "periods_ends_on_or_after_start" CHECK("periods"."ends_on" >= "periods"."starts_on")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `periods_organisation_id_id_unique` ON `periods` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `periods_organisation_id_user_id_starts_on_unique` ON `periods` (`organisation_id`,`user_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `periods_organisation_id_status_starts_on_idx` ON `periods` (`organisation_id`,`status`,`starts_on`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`client_id` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`client_id`) REFERENCES `clients`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_organisation_id_id_unique` ON `projects` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_organisation_id_name_key_unique` ON `projects` (`organisation_id`,`name_key`);--> statement-breakpoint
CREATE INDEX `projects_organisation_id_client_id_idx` ON `projects` (`organisation_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`is_manager` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`team_id`) REFERENCES `teams`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`user_id`) REFERENCES `memberships`(`organisation_id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_members_team_id_user_id_unique` ON `team_members` (`team_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `team_members_organisation_id_user_id_idx` ON `team_members` (`organisation_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_organisation_id_id_unique` ON `teams` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_organisation_id_name_key_unique` ON `teams` (`organisation_id`,`name_key`);--> statement-breakpoint
CREATE TABLE `time_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`description` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "time_entries_ends_after_start" CHECK("time_entries"."ended_at" IS NULL OR "time_entries"."ended_at" >= "time_entries"."started_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `time_entries_one_running_per_person` ON `time_entries` (`organisation_id`,`user_id`) WHERE "time_entries"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `time_entries_organisation_id_user_id_started_at_idx` ON `time_entries` (`organisation_id`,`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `time_entries_organisation_id_project_id_started_at_idx` ON `time_entries` (`organisation_id`,`project_id`,`started_at`);--> statement-breakpoint
ALTER TABLE `organisations` ADD `time_zone` text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `week_starts_on` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `clients_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `time_zone` text;