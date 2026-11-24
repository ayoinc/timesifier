-- Invite many, and import people from a CSV (TS-108; docs/decisions.md entry 72).
--
-- Only adds. `people_imports` holds each CSV import of people, apart from
-- `import_jobs`, whose kind check names the time import's kinds and is left
-- as it is. `invitation_plans` holds, for each invitation sent with others,
-- the team, manager, schedule and start date to apply when it is accepted,
-- the name the import gave, and whether its email has gone. No row is written.
CREATE TABLE `people_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`status` text DEFAULT 'previewed' NOT NULL,
	`file_name` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`source` text,
	`mapping` text,
	`skipped` text,
	`created_by` text NOT NULL,
	`imported_at` integer,
	`reverted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "people_imports_status_known" CHECK("people_imports"."status" IN ('previewed', 'imported', 'reverted')),
	CONSTRAINT "people_imports_counts_not_negative" CHECK("people_imports"."row_count" >= 0 AND "people_imports"."imported_count" >= 0 AND "people_imports"."skipped_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_imports_organisation_id_id_unique` ON `people_imports` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `people_imports_organisation_id_created_at_idx` ON `people_imports` (`organisation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `invitation_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`invitation_id` text NOT NULL,
	`import_id` text,
	`name` text,
	`team_id` text,
	`manager_email` text,
	`schedule_id` text,
	`starts_on` text,
	`created_by` text,
	`mail_state` text DEFAULT 'waiting' NOT NULL,
	`mailed_at` integer,
	`applied_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invitation_id`) REFERENCES `invitations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organisation_id`,`import_id`) REFERENCES `people_imports`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invitation_plans_mail_state_known" CHECK("invitation_plans"."mail_state" IN ('waiting', 'sending', 'sent', 'withdrawn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_plans_organisation_id_id_unique` ON `invitation_plans` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_plans_invitation_id_unique` ON `invitation_plans` (`invitation_id`);--> statement-breakpoint
CREATE INDEX `invitation_plans_organisation_id_import_id_idx` ON `invitation_plans` (`organisation_id`,`import_id`);--> statement-breakpoint
CREATE INDEX `invitation_plans_mail_state_mailed_at_idx` ON `invitation_plans` (`mail_state`,`mailed_at`);
