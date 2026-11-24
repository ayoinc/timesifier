-- Work packages (TS-115b; docs/decisions.md entry 73).
--
-- Only adds. `work_packages` holds each project's work packages, and
-- `time_entries.work_package_id` the one an entry goes to. The column is added
-- in place with no reference, as `task_id` was: a reference would rebuild the
-- table. Its triggers hold what a reference would: an entry's work package is
-- one of its own project's, in its own organisation, and a work package never
-- moves to another project. No row is written; existing entries have none.
CREATE TABLE `work_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`code` text NOT NULL,
	`code_key` text NOT NULL,
	`name` text NOT NULL,
	`starts_on` text,
	`ends_on` text,
	`state` text DEFAULT 'open' NOT NULL,
	`budget_kind` text DEFAULT 'none' NOT NULL,
	`budget_amount` integer,
	`billable` integer DEFAULT true NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "work_packages_state_known" CHECK("work_packages"."state" IN ('open', 'closed')),
	CONSTRAINT "work_packages_budget_kind_known" CHECK("work_packages"."budget_kind" IN ('none', 'hours', 'fees')),
	CONSTRAINT "work_packages_budget_amount_not_negative" CHECK("work_packages"."budget_amount" IS NULL OR "work_packages"."budget_amount" >= 0),
	CONSTRAINT "work_packages_ends_after_start" CHECK("work_packages"."starts_on" IS NULL OR "work_packages"."ends_on" IS NULL OR "work_packages"."ends_on" >= "work_packages"."starts_on")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_packages_organisation_id_id_unique` ON `work_packages` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_packages_project_id_code_key_unique` ON `work_packages` (`project_id`,`code_key`);--> statement-breakpoint
CREATE INDEX `work_packages_organisation_id_project_id_idx` ON `work_packages` (`organisation_id`,`project_id`);--> statement-breakpoint
ALTER TABLE `time_entries` ADD `work_package_id` text;--> statement-breakpoint
CREATE INDEX `time_entries_organisation_id_work_package_id_idx` ON `time_entries` (`organisation_id`,`work_package_id`);
--> statement-breakpoint
CREATE TRIGGER `time_entries_work_package_inserted`
BEFORE INSERT ON `time_entries`
FOR EACH ROW
WHEN NEW.`work_package_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `work_packages` AS w
	WHERE w.`id` = NEW.`work_package_id`
		AND w.`organisation_id` = NEW.`organisation_id`
		AND w.`project_id` = NEW.`project_id`
)
BEGIN
	SELECT RAISE(ABORT, 'an entry''s work package is one of its own project''s');
END;
--> statement-breakpoint
CREATE TRIGGER `time_entries_work_package_updated`
BEFORE UPDATE OF `work_package_id`, `project_id`, `organisation_id` ON `time_entries`
FOR EACH ROW
WHEN NEW.`work_package_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `work_packages` AS w
	WHERE w.`id` = NEW.`work_package_id`
		AND w.`organisation_id` = NEW.`organisation_id`
		AND w.`project_id` = NEW.`project_id`
)
BEGIN
	SELECT RAISE(ABORT, 'an entry''s work package is one of its own project''s');
END;
--> statement-breakpoint
CREATE TRIGGER `work_packages_stay_in_project`
BEFORE UPDATE OF `project_id`, `organisation_id` ON `work_packages`
FOR EACH ROW
WHEN NEW.`project_id` IS NOT OLD.`project_id` OR NEW.`organisation_id` IS NOT OLD.`organisation_id`
BEGIN
	SELECT RAISE(ABORT, 'a work package stays in its project');
END;
