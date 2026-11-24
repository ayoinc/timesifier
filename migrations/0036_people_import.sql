-- Invite many, and import people from a CSV (TS-108; docs/decisions.md entry 72).
--
-- An import may now be of people, so the kind check of `import_jobs` names
-- `people` too: SQLite cannot change a CHECK in place, so the table is made
-- again with its rows, as 0026 did for `work_requests`. Nothing refers to
-- `import_jobs` before this migration.
--
-- `invitation_plans` is new: for each invitation sent with others, the team,
-- manager, schedule and start date to apply when it is accepted, the name the
-- import gave, and whether its email has gone. No row is written.
CREATE TABLE `__new_import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`kind` text NOT NULL,
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
	CONSTRAINT "import_jobs_kind_known" CHECK("__new_import_jobs"."kind" IN ('time', 'clients', 'projects', 'expenses', 'people')),
	CONSTRAINT "import_jobs_status_known" CHECK("__new_import_jobs"."status" IN ('previewed', 'imported', 'reverted', 'failed')),
	CONSTRAINT "import_jobs_counts_not_negative" CHECK("__new_import_jobs"."row_count" >= 0 AND "__new_import_jobs"."imported_count" >= 0 AND "__new_import_jobs"."skipped_count" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_import_jobs`("id", "organisation_id", "kind", "status", "file_name", "row_count", "imported_count", "skipped_count", "source", "mapping", "skipped", "created_by", "imported_at", "reverted_at", "created_at") SELECT "id", "organisation_id", "kind", "status", "file_name", "row_count", "imported_count", "skipped_count", "source", "mapping", "skipped", "created_by", "imported_at", "reverted_at", "created_at" FROM `import_jobs`;--> statement-breakpoint
DROP TABLE `import_jobs`;--> statement-breakpoint
ALTER TABLE `__new_import_jobs` RENAME TO `import_jobs`;--> statement-breakpoint
CREATE UNIQUE INDEX `import_jobs_organisation_id_id_unique` ON `import_jobs` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `import_jobs_organisation_id_created_at_idx` ON `import_jobs` (`organisation_id`,`created_at`);--> statement-breakpoint
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
	FOREIGN KEY (`organisation_id`,`import_id`) REFERENCES `import_jobs`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invitation_plans_mail_state_known" CHECK("invitation_plans"."mail_state" IN ('waiting', 'sending', 'sent', 'withdrawn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_plans_organisation_id_id_unique` ON `invitation_plans` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_plans_invitation_id_unique` ON `invitation_plans` (`invitation_id`);--> statement-breakpoint
CREATE INDEX `invitation_plans_organisation_id_import_id_idx` ON `invitation_plans` (`organisation_id`,`import_id`);--> statement-breakpoint
CREATE INDEX `invitation_plans_mail_state_mailed_at_idx` ON `invitation_plans` (`mail_state`,`mailed_at`);
