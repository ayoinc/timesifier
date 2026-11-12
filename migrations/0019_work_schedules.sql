CREATE TABLE `schedule_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`schedule_id` text,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`source_kind` text DEFAULT 'manual' NOT NULL,
	`source_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`schedule_id`) REFERENCES `work_schedules`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "schedule_assignments_target_kind_known" CHECK("schedule_assignments"."target_kind" IN ('person', 'team', 'role', 'organisation')),
	CONSTRAINT "schedule_assignments_organisation_has_schedule" CHECK("schedule_assignments"."target_kind" <> 'organisation' OR "schedule_assignments"."schedule_id" IS NOT NULL),
	CONSTRAINT "schedule_assignments_source_kind_known" CHECK("schedule_assignments"."source_kind" IN ('manual', 'contract'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_assignments_organisation_id_id_unique` ON `schedule_assignments` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_assignments_target_effective_from_unique` ON `schedule_assignments` (`organisation_id`,`target_kind`,`target_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `work_schedule_days` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`version_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`start_minute` integer NOT NULL,
	`finish_minute` integer NOT NULL,
	`break_minutes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`version_id`) REFERENCES `work_schedule_versions`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "work_schedule_days_weekday_in_range" CHECK("work_schedule_days"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "work_schedule_days_times_in_range" CHECK("work_schedule_days"."start_minute" >= 0 AND "work_schedule_days"."finish_minute" <= 1440 AND "work_schedule_days"."finish_minute" > "work_schedule_days"."start_minute"),
	CONSTRAINT "work_schedule_days_break_fits" CHECK("work_schedule_days"."break_minutes" >= 0 AND "work_schedule_days"."break_minutes" < "work_schedule_days"."finish_minute" - "work_schedule_days"."start_minute")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_schedule_days_organisation_id_id_unique` ON `work_schedule_days` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_schedule_days_version_id_weekday_unique` ON `work_schedule_days` (`version_id`,`weekday`);--> statement-breakpoint
CREATE TABLE `work_schedule_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`schedule_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`overtime_policy` text,
	`overtime_day_cap_minutes` integer,
	`overtime_week_cap_minutes` integer,
	`non_working_days` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`schedule_id`) REFERENCES `work_schedules`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "work_schedule_versions_overtime_policy_known" CHECK("work_schedule_versions"."overtime_policy" IS NULL OR "work_schedule_versions"."overtime_policy" IN ('none', 'allowed', 'approval')),
	CONSTRAINT "work_schedule_versions_non_working_days_known" CHECK("work_schedule_versions"."non_working_days" IS NULL OR "work_schedule_versions"."non_working_days" IN ('overtime', 'none'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_schedule_versions_organisation_id_id_unique` ON `work_schedule_versions` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_schedule_versions_schedule_id_effective_from_unique` ON `work_schedule_versions` (`schedule_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `work_schedules` (
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
CREATE UNIQUE INDEX `work_schedules_organisation_id_id_unique` ON `work_schedules` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_schedules_organisation_id_name_key_unique` ON `work_schedules` (`organisation_id`,`name_key`);
--> statement-breakpoint
-- Work schedules (TS-097): what is written above is generated from
-- `app/db/schema.ts`; what follows is written by hand.
--
-- Every organisation has two schedules to start from, each worked Monday to
-- Friday: "Standard", 09:00 to 17:30 with an unpaid hour's break (7.5 hours a
-- day, 37.5 a week), and "Long", 09:00 to 18:00 with an hour's break (8 hours,
-- 40 a week). Each schedule's first version holds from `0001-01-01`, so every
-- day before a change keeps it. The organisation's default is Standard, which
-- is the working week every organisation started with.
--
-- An organisation that changed its working week keeps it: it becomes the
-- schedule "Working week", its default, each day worked keeping its minutes,
-- starting at 09:00 with an hour's break on a day of more than six hours, and
-- finishing when the minutes are done (earlier, on a day too long to finish
-- by midnight). Nothing anybody is expected to work changes. `working_days`
-- is no longer read; a later migration, which ships alone, takes it away.
--
-- The trigger gives a new organisation Standard and Long, Standard its
-- default, whichever way it is created. Ids are UUID version 7, as
-- `migrations/0007_leave.sql` makes them. One row a statement where D1 would
-- otherwise need a compound SELECT.
CREATE TRIGGER `organisations_schedule_defaults`
AFTER INSERT ON `organisations`
FOR EACH ROW
BEGIN
	INSERT INTO `work_schedules` (`id`, `organisation_id`, `name`, `name_key`, `archived_at`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'Standard', 'standard', NULL, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `work_schedules` (`id`, `organisation_id`, `name`, `name_key`, `archived_at`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'Long', 'long', NULL, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `work_schedule_versions` (`id`, `organisation_id`, `schedule_id`, `effective_from`, `overtime_policy`, `overtime_day_cap_minutes`, `overtime_week_cap_minutes`, `non_working_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		`s`.`organisation_id`, `s`.`id`, '0001-01-01', NULL, NULL, NULL, NULL, `now`, `now`
	FROM `work_schedules` AS `s` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `s`.`organisation_id` = NEW.`id`;
	INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		`v`.`organisation_id`, `v`.`id`, 1, 540, 1050, 60, `now`, `now`
	FROM `work_schedule_versions` AS `v`
		JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
		CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `s`.`name_key` = 'standard' AND `s`.`organisation_id` = NEW.`id`;
	INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		`v`.`organisation_id`, `v`.`id`, 2, 540, 1050, 60, `now`, `now`
	FROM `work_schedule_versions` AS `v`
		JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
		CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `s`.`name_key` = 'standard' AND `s`.`organisation_id` = NEW.`id`;
	INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		`v`.`organisation_id`, `v`.`id`, 3, 540, 1050, 60, `now`, `now`
	FROM `work_schedule_versions` AS `v`
		JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
		CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `s`.`name_key` = 'standard' AND `s`.`organisation_id` = NEW.`id`;
	INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		`v`.`organisation_id`, `v`.`id`, 4, 540, 1050, 60, `now`, `now`
	FROM `work_schedule_versions` AS `v`
		JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
		CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `s`.`name_key` = 'standard' AND `s`.`organisation_id` = NEW.`id`;
	INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		`v`.`organisation_id`, `v`.`id`, 5, 540, 1050, 60, `now`, `now`
	FROM `work_schedule_versions` AS `v`
		JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
		CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `s`.`name_key` = 'standard' AND `s`.`organisation_id` = NEW.`id`;
	INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		`v`.`organisation_id`, `v`.`id`, 1, 540, 1080, 60, `now`, `now`
	FROM `work_schedule_versions` AS `v`
		JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
		CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `s`.`name_key` = 'long' AND `s`.`organisation_id` = NEW.`id`;
	INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		`v`.`organisation_id`, `v`.`id`, 2, 540, 1080, 60, `now`, `now`
	FROM `work_schedule_versions` AS `v`
		JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
		CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `s`.`name_key` = 'long' AND `s`.`organisation_id` = NEW.`id`;
	INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		`v`.`organisation_id`, `v`.`id`, 3, 540, 1080, 60, `now`, `now`
	FROM `work_schedule_versions` AS `v`
		JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
		CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `s`.`name_key` = 'long' AND `s`.`organisation_id` = NEW.`id`;
	INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		`v`.`organisation_id`, `v`.`id`, 4, 540, 1080, 60, `now`, `now`
	FROM `work_schedule_versions` AS `v`
		JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
		CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `s`.`name_key` = 'long' AND `s`.`organisation_id` = NEW.`id`;
	INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		`v`.`organisation_id`, `v`.`id`, 5, 540, 1080, 60, `now`, `now`
	FROM `work_schedule_versions` AS `v`
		JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
		CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `s`.`name_key` = 'long' AND `s`.`organisation_id` = NEW.`id`;
	INSERT INTO `schedule_assignments` (`id`, `organisation_id`, `schedule_id`, `target_kind`, `target_id`, `effective_from`, `source_kind`, `source_id`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, (SELECT `id` FROM `work_schedules` WHERE `organisation_id` = NEW.`id` AND `name_key` = 'standard'), 'organisation', '', '0001-01-01', 'manual', NULL, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
END;
--> statement-breakpoint
INSERT INTO `work_schedules` (`id`, `organisation_id`, `name`, `name_key`, `archived_at`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 'Standard', 'standard', NULL, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `work_schedules` (`id`, `organisation_id`, `name`, `name_key`, `archived_at`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 'Long', 'long', NULL, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `work_schedules` (`id`, `organisation_id`, `name`, `name_key`, `archived_at`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 'Working week', 'working week', NULL, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE EXISTS (SELECT 1 FROM `working_days` AS `w` WHERE `w`.`organisation_id` = `organisations`.`id`)
	AND (
		SELECT count(*) FROM `working_days` AS `w`
		WHERE `w`.`organisation_id` = `organisations`.`id`
			AND `w`.`minutes` = CASE WHEN `w`.`weekday` <= 5 THEN 450 ELSE 0 END
	) <> 7;
--> statement-breakpoint
INSERT INTO `work_schedule_versions` (`id`, `organisation_id`, `schedule_id`, `effective_from`, `overtime_policy`, `overtime_day_cap_minutes`, `overtime_week_cap_minutes`, `non_working_days`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`s`.`organisation_id`, `s`.`id`, '0001-01-01', NULL, NULL, NULL, NULL, `now`, `now`
FROM `work_schedules` AS `s` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`v`.`organisation_id`, `v`.`id`, 1, 540, 1050, 60, `now`, `now`
FROM `work_schedule_versions` AS `v`
	JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
	CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE `s`.`name_key` = 'standard';
--> statement-breakpoint
INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`v`.`organisation_id`, `v`.`id`, 2, 540, 1050, 60, `now`, `now`
FROM `work_schedule_versions` AS `v`
	JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
	CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE `s`.`name_key` = 'standard';
--> statement-breakpoint
INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`v`.`organisation_id`, `v`.`id`, 3, 540, 1050, 60, `now`, `now`
FROM `work_schedule_versions` AS `v`
	JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
	CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE `s`.`name_key` = 'standard';
--> statement-breakpoint
INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`v`.`organisation_id`, `v`.`id`, 4, 540, 1050, 60, `now`, `now`
FROM `work_schedule_versions` AS `v`
	JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
	CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE `s`.`name_key` = 'standard';
--> statement-breakpoint
INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`v`.`organisation_id`, `v`.`id`, 5, 540, 1050, 60, `now`, `now`
FROM `work_schedule_versions` AS `v`
	JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
	CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE `s`.`name_key` = 'standard';
--> statement-breakpoint
INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`v`.`organisation_id`, `v`.`id`, 1, 540, 1080, 60, `now`, `now`
FROM `work_schedule_versions` AS `v`
	JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
	CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE `s`.`name_key` = 'long';
--> statement-breakpoint
INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`v`.`organisation_id`, `v`.`id`, 2, 540, 1080, 60, `now`, `now`
FROM `work_schedule_versions` AS `v`
	JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
	CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE `s`.`name_key` = 'long';
--> statement-breakpoint
INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`v`.`organisation_id`, `v`.`id`, 3, 540, 1080, 60, `now`, `now`
FROM `work_schedule_versions` AS `v`
	JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
	CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE `s`.`name_key` = 'long';
--> statement-breakpoint
INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`v`.`organisation_id`, `v`.`id`, 4, 540, 1080, 60, `now`, `now`
FROM `work_schedule_versions` AS `v`
	JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
	CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE `s`.`name_key` = 'long';
--> statement-breakpoint
INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`v`.`organisation_id`, `v`.`id`, 5, 540, 1080, 60, `now`, `now`
FROM `work_schedule_versions` AS `v`
	JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
	CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE `s`.`name_key` = 'long';
--> statement-breakpoint
INSERT INTO `work_schedule_days` (`id`, `organisation_id`, `version_id`, `weekday`, `start_minute`, `finish_minute`, `break_minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisation_id`, `version_id`, `weekday`, `start`, `start` + `minutes` + `break`, `break`, `now`, `now`
FROM (
	SELECT `organisation_id`, `version_id`, `weekday`, `minutes`, `break`,
		min(540, 1440 - `minutes` - `break`) AS `start`
	FROM (
		SELECT `v`.`organisation_id`, `v`.`id` AS `version_id`, `w`.`weekday`, `w`.`minutes`,
			CASE WHEN `w`.`minutes` > 360 AND `w`.`minutes` <= 1380 THEN 60 ELSE 0 END AS `break`
		FROM `work_schedule_versions` AS `v`
			JOIN `work_schedules` AS `s` ON `s`.`organisation_id` = `v`.`organisation_id` AND `s`.`id` = `v`.`schedule_id`
			JOIN `working_days` AS `w` ON `w`.`organisation_id` = `s`.`organisation_id`
		WHERE `s`.`name_key` = 'working week' AND `w`.`minutes` > 0
	)
) CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `schedule_assignments` (`id`, `organisation_id`, `schedule_id`, `target_kind`, `target_id`, `effective_from`, `source_kind`, `source_id`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, coalesce(
		(SELECT `id` FROM `work_schedules` WHERE `organisation_id` = `organisations`.`id` AND `name_key` = 'working week'),
		(SELECT `id` FROM `work_schedules` WHERE `organisation_id` = `organisations`.`id` AND `name_key` = 'standard')
	), 'organisation', '', '0001-01-01', 'manual', NULL, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
