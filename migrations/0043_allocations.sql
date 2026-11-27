-- TS-116, decision 78: time shares (allocations). Only adds a table.
CREATE TABLE `allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`work_package_id` text,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`amount` integer NOT NULL,
	`unit` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`work_package_id`) REFERENCES `work_packages`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "allocations_unit_known" CHECK("allocations"."unit" IN ('days', 'hours', 'percent')),
	CONSTRAINT "allocations_amount_in_range" CHECK("allocations"."amount" > 0 AND "allocations"."amount" <= CASE "allocations"."unit" WHEN 'days' THEN 700 WHEN 'hours' THEN 16800 ELSE 10000 END),
	CONSTRAINT "allocations_starts_on_is_a_day" CHECK(date("allocations"."starts_on") IS "allocations"."starts_on"),
	CONSTRAINT "allocations_ends_on_is_a_day" CHECK("allocations"."ends_on" IS NULL OR (date("allocations"."ends_on") IS "allocations"."ends_on" AND "allocations"."ends_on" >= "allocations"."starts_on"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allocations_organisation_id_id_unique` ON `allocations` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `allocations_user_starts_on_index` ON `allocations` (`organisation_id`,`user_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `allocations_project_index` ON `allocations` (`organisation_id`,`project_id`);--> statement-breakpoint
-- TS-116, decision 78: a person's time share of a project or of one of its
-- work packages. Only adds a table. No two shares of one person on one
-- project and work package (or the whole project) share a day: the server
-- refuses an overlap first and says why; these refuse the one a race lets
-- through. An open share runs to the end of time.
CREATE TRIGGER `allocations_no_overlap_insert`
BEFORE INSERT ON `allocations`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1 FROM `allocations` AS `other`
	WHERE `other`.`organisation_id` = NEW.`organisation_id`
		AND `other`.`project_id` = NEW.`project_id`
		AND `other`.`user_id` = NEW.`user_id`
		AND `other`.`work_package_id` IS NEW.`work_package_id`
		AND `other`.`starts_on` <= coalesce(NEW.`ends_on`, '9999-12-31')
		AND NEW.`starts_on` <= coalesce(`other`.`ends_on`, '9999-12-31')
)
BEGIN
	SELECT RAISE(ABORT, 'a person''s time shares of a project never overlap');
END;
--> statement-breakpoint
CREATE TRIGGER `allocations_no_overlap_update`
BEFORE UPDATE OF `organisation_id`, `project_id`, `work_package_id`, `user_id`, `starts_on`, `ends_on` ON `allocations`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1 FROM `allocations` AS `other`
	WHERE `other`.`organisation_id` = NEW.`organisation_id`
		AND `other`.`project_id` = NEW.`project_id`
		AND `other`.`user_id` = NEW.`user_id`
		AND `other`.`work_package_id` IS NEW.`work_package_id`
		AND `other`.`id` <> OLD.`id`
		AND `other`.`starts_on` <= coalesce(NEW.`ends_on`, '9999-12-31')
		AND NEW.`starts_on` <= coalesce(`other`.`ends_on`, '9999-12-31')
)
BEGIN
	SELECT RAISE(ABORT, 'a person''s time shares of a project never overlap');
END;
