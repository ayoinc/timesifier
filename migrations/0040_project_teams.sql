CREATE TABLE `project_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`source_kind` text DEFAULT 'manual' NOT NULL,
	`source_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_members_role_known" CHECK("project_members"."role" IN ('member', 'delivery_manager')),
	CONSTRAINT "project_members_starts_on_is_a_day" CHECK(date("project_members"."starts_on") IS "project_members"."starts_on"),
	CONSTRAINT "project_members_ends_on_is_a_day" CHECK("project_members"."ends_on" IS NULL OR (date("project_members"."ends_on") IS "project_members"."ends_on" AND "project_members"."ends_on" >= "project_members"."starts_on")),
	CONSTRAINT "project_members_source_kind_known" CHECK("project_members"."source_kind" IN ('manual', 'import', 'contract'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_members_organisation_id_id_unique` ON `project_members` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `project_members_project_user_starts_on_index` ON `project_members` (`organisation_id`,`project_id`,`user_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `project_members_user_index` ON `project_members` (`organisation_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `setup_imports` (
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
	`created` text,
	`created_by` text NOT NULL,
	`imported_at` integer,
	`reverted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "setup_imports_status_known" CHECK("setup_imports"."status" IN ('previewed', 'imported', 'reverted')),
	CONSTRAINT "setup_imports_counts_not_negative" CHECK("setup_imports"."row_count" >= 0 AND "setup_imports"."imported_count" >= 0 AND "setup_imports"."skipped_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setup_imports_organisation_id_id_unique` ON `setup_imports` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `setup_imports_organisation_id_created_at_idx` ON `setup_imports` (`organisation_id`,`created_at`);--> statement-breakpoint
-- Existing organisations keep `anyone`: whoever is in one may track to any
-- active project, as before. A new one that works on client projects is set to
-- `assigned` as it is created (`startWorkModel`).
ALTER TABLE `organisations` ADD `project_tracking` text DEFAULT 'anyone' NOT NULL;--> statement-breakpoint
-- No two assignments of one person to one project share a day (TS-115c,
-- decision 75): a change is a new row from its day. The server refuses an
-- overlap first and says why; these refuse the one a race lets through. An
-- open assignment runs to the end of time.
CREATE TRIGGER `project_members_no_overlap_insert`
BEFORE INSERT ON `project_members`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1 FROM `project_members` AS `other`
	WHERE `other`.`organisation_id` = NEW.`organisation_id`
		AND `other`.`project_id` = NEW.`project_id`
		AND `other`.`user_id` = NEW.`user_id`
		AND `other`.`starts_on` <= coalesce(NEW.`ends_on`, '9999-12-31')
		AND NEW.`starts_on` <= coalesce(`other`.`ends_on`, '9999-12-31')
)
BEGIN
	SELECT RAISE(ABORT, 'a person''s assignments to a project never overlap');
END;
--> statement-breakpoint
CREATE TRIGGER `project_members_no_overlap_update`
BEFORE UPDATE OF `organisation_id`, `project_id`, `user_id`, `starts_on`, `ends_on` ON `project_members`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1 FROM `project_members` AS `other`
	WHERE `other`.`organisation_id` = NEW.`organisation_id`
		AND `other`.`project_id` = NEW.`project_id`
		AND `other`.`user_id` = NEW.`user_id`
		AND `other`.`id` <> OLD.`id`
		AND `other`.`starts_on` <= coalesce(NEW.`ends_on`, '9999-12-31')
		AND NEW.`starts_on` <= coalesce(`other`.`ends_on`, '9999-12-31')
)
BEGIN
	SELECT RAISE(ABORT, 'a person''s assignments to a project never overlap');
END;
