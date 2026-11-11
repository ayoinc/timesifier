CREATE TABLE `leave_kinds` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`needs_approval` integer DEFAULT true NOT NULL,
	`allowance_half_days` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "leave_kinds_key_known" CHECK("leave_kinds"."key" IN ('annual', 'sick', 'study', 'parental', 'unpaid', 'holiday')),
	CONSTRAINT "leave_kinds_allowance_in_range" CHECK("leave_kinds"."allowance_half_days" IS NULL OR "leave_kinds"."allowance_half_days" BETWEEN 0 AND 730)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leave_kinds_organisation_id_id_unique` ON `leave_kinds` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `leave_kinds_organisation_id_key_unique` ON `leave_kinds` (`organisation_id`,`key`);--> statement-breakpoint
CREATE TABLE `leave_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind_id` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`starts_half` integer DEFAULT false NOT NULL,
	`ends_half` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`decided_by` text,
	`decided_at` integer,
	`comment` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`kind_id`) REFERENCES `leave_kinds`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`user_id`) REFERENCES `memberships`(`organisation_id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "leave_requests_status_known" CHECK("leave_requests"."status" IN ('pending', 'approved', 'refused', 'withdrawn', 'cancelled')),
	CONSTRAINT "leave_requests_ends_on_or_after_start" CHECK("leave_requests"."ends_on" >= "leave_requests"."starts_on"),
	CONSTRAINT "leave_requests_one_half_on_one_day" CHECK("leave_requests"."ends_on" > "leave_requests"."starts_on" OR NOT "leave_requests"."ends_half")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leave_requests_organisation_id_id_unique` ON `leave_requests` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `leave_requests_organisation_id_user_id_starts_on_idx` ON `leave_requests` (`organisation_id`,`user_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `leave_requests_organisation_id_status_starts_on_idx` ON `leave_requests` (`organisation_id`,`status`,`starts_on`);--> statement-breakpoint
CREATE TABLE `public_holidays` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`day` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_holidays_organisation_id_id_unique` ON `public_holidays` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `public_holidays_organisation_id_day_unique` ON `public_holidays` (`organisation_id`,`day`);--> statement-breakpoint
CREATE TABLE `working_days` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`minutes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "working_days_weekday_in_range" CHECK("working_days"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "working_days_minutes_in_range" CHECK("working_days"."minutes" BETWEEN 0 AND 1440)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `working_days_organisation_id_weekday_unique` ON `working_days` (`organisation_id`,`weekday`);--> statement-breakpoint
-- Written by hand from here: drizzle-kit has no notation for a trigger or for
-- rows, so the schema and the snapshot say nothing of what follows.
--
-- Every organisation has the six kinds of leave and a working week of Monday
-- to Friday, 7.5 hours (450 minutes) a day (TS-061). The trigger gives them to
-- an organisation as it is created, whichever way it is created; the
-- statements after it give them to every organisation that already exists.
-- Annual leave starts with an allowance of 25 days (50 half days); sick leave
-- and public holidays need no decision. One row a statement: D1 refuses a
-- compound SELECT of more than a few terms.
--
-- An id is a UUID version 7 (app/db/uuidv7.ts): the time in milliseconds, then
-- random bits with the version and the variant set. A table that is rebuilt
-- loses its triggers: a migration that rebuilds `organisations` must create
-- this one again.
CREATE TRIGGER `organisations_leave_defaults`
AFTER INSERT ON `organisations`
FOR EACH ROW
BEGIN
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'annual', 'Annual leave', 1, 1, 50, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'sick', 'Sick leave', 1, 0, NULL, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'study', 'Study leave', 1, 1, NULL, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'parental', 'Parental leave', 1, 1, NULL, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'unpaid', 'Unpaid leave', 1, 1, NULL, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'holiday', 'Public holiday', 1, 0, NULL, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 1, 450, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 2, 450, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 3, 450, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 4, 450, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 5, 450, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 6, 0, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 7, 0, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
END;
--> statement-breakpoint
INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 'annual', 'Annual leave', 1, 1, 50, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 'sick', 'Sick leave', 1, 0, NULL, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 'study', 'Study leave', 1, 1, NULL, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 'parental', 'Parental leave', 1, 1, NULL, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 'unpaid', 'Unpaid leave', 1, 1, NULL, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 'holiday', 'Public holiday', 1, 0, NULL, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 1, 450, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 2, 450, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 3, 450, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 4, 450, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 5, 450, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 6, 0, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
--> statement-breakpoint
INSERT INTO `working_days` (`id`, `organisation_id`, `weekday`, `minutes`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`organisations`.`id`, 7, 0, `now`, `now`
FROM `organisations` CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
