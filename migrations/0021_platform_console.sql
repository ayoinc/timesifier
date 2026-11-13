-- The platform console (TS-099): the platform owners' step-up, their log,
-- support access an organisation grants, sign-in history, mailings, each
-- organisation's plan and seats, and each person's choice of mail and whether
-- their account is closed. Every existing organisation starts on Free, every
-- existing person with announcements on and the newsletter off.
CREATE TABLE `mailing_deliveries` (
	`mailing_id` text NOT NULL,
	`user_id` text NOT NULL,
	`sent_at` integer,
	`outcome` text,
	PRIMARY KEY(`mailing_id`, `user_id`),
	FOREIGN KEY (`mailing_id`) REFERENCES `mailings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailing_deliveries_sent_at_idx` ON `mailing_deliveries` (`sent_at`);--> statement-breakpoint
CREATE TABLE `mailings` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`sent_by` text,
	`recipients` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sent_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mailings_kind_known" CHECK("mailings"."kind" IN ('announcement', 'newsletter'))
);
--> statement-breakpoint
CREATE INDEX `mailings_created_at_idx` ON `mailings` (`created_at`);--> statement-breakpoint
CREATE TABLE `platform_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text,
	`reason` text,
	`detail` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `platform_events_created_at_idx` ON `platform_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `platform_events_subject_idx` ON `platform_events` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `platform_step_ups` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text,
	`code_expires_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sign_ins` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sign_ins_user_id_created_at_idx` ON `sign_ins` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sign_ins_created_at_idx` ON `sign_ins` (`created_at`);--> statement-breakpoint
CREATE TABLE `support_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`granted_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_grants_organisation_id_id_unique` ON `support_grants` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `support_grants_organisation_id_expires_at_idx` ON `support_grants` (`organisation_id`,`expires_at`);--> statement-breakpoint
ALTER TABLE `organisations` ADD `plan` text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `seats` integer;--> statement-breakpoint
ALTER TABLE `organisations` ADD `trial_ends_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `newsletter` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `announcements` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `closed_at` integer;