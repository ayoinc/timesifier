ALTER TABLE `leave_kinds` ADD `notice_days` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Written by hand from here: drizzle-kit has no notation for rows or triggers.
--
-- Notice for leave (TS-090). Each kind asks for days of notice: annual and
-- unpaid leave 14, study leave 28, parental leave 56; sick leave and public
-- holidays none. The statements below give every organisation that exists
-- those days; the trigger `organisations_leave_defaults` of `0007_leave` is
-- made again with the column, so a new organisation gets them too. It ships
-- alone, ahead of the code that reads the column, as a migration that drops
-- must.
UPDATE `leave_kinds` SET `notice_days` = 14 WHERE `key` = 'annual';
--> statement-breakpoint
UPDATE `leave_kinds` SET `notice_days` = 28 WHERE `key` = 'study';
--> statement-breakpoint
UPDATE `leave_kinds` SET `notice_days` = 56 WHERE `key` = 'parental';
--> statement-breakpoint
UPDATE `leave_kinds` SET `notice_days` = 14 WHERE `key` = 'unpaid';
--> statement-breakpoint
DROP TRIGGER `organisations_leave_defaults`;
--> statement-breakpoint
CREATE TRIGGER `organisations_leave_defaults`
AFTER INSERT ON `organisations`
FOR EACH ROW
BEGIN
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `notice_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'annual', 'Annual leave', 1, 1, 50, 14, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `notice_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'sick', 'Sick leave', 1, 0, NULL, 0, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `notice_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'study', 'Study leave', 1, 1, NULL, 28, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `notice_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'parental', 'Parental leave', 1, 1, NULL, 56, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `notice_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'unpaid', 'Unpaid leave', 1, 1, NULL, 14, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
	INSERT INTO `leave_kinds` (`id`, `organisation_id`, `key`, `name`, `enabled`, `needs_approval`, `allowance_half_days`, `notice_days`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'holiday', 'Public holiday', 1, 0, NULL, 0, `now`, `now`
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
