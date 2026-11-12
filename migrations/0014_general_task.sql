-- Tasks (TS-066, B4). Every entry has a task from its project's list, so the
-- entries made before tasks get one: each organisation is given a common,
-- billable task called "General" (unless it already has a task of that name),
-- every project of the organisation has it on its list, billable unless the
-- project bills nothing, and every entry with no task is given it, billable
-- as the task is on its project.
--
-- From here on two triggers keep that true for every writer, the pages, the
-- API and an import alike: a new organisation starts with "General", and a
-- new project starts with the organisation's common tasks that are not
-- archived, each billable as its default says unless the project bills
-- nothing.
--
-- An id is a UUID version 7 (app/db/uuidv7.ts), built as migration 0007 builds
-- one. A table that is rebuilt loses its triggers: a migration that rebuilds
-- `organisations` or `projects` must create these again.
INSERT INTO `tasks` (`id`, `organisation_id`, `name`, `name_key`, `billable_by_default`, `common`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`o`.`id`, 'General', 'general', 1, 1, `now`, `now`
FROM `organisations` AS `o`, (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE NOT EXISTS (
	SELECT 1 FROM `tasks` AS `t` WHERE `t`.`organisation_id` = `o`.`id` AND `t`.`name_key` = 'general'
);
--> statement-breakpoint
INSERT INTO `project_tasks` (`id`, `organisation_id`, `project_id`, `task_id`, `billable`, `created_at`, `updated_at`)
SELECT
	substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
		|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
	`p`.`organisation_id`, `p`.`id`, `t`.`id`, `p`.`billing_type` <> 'non_billable', `now`, `now`
FROM `projects` AS `p`
JOIN `tasks` AS `t` ON `t`.`organisation_id` = `p`.`organisation_id` AND `t`.`name_key` = 'general',
	(SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
WHERE NOT EXISTS (
	SELECT 1 FROM `project_tasks` AS `pt` WHERE `pt`.`project_id` = `p`.`id` AND `pt`.`task_id` = `t`.`id`
);
--> statement-breakpoint
UPDATE `time_entries`
SET
	`task_id` = (
		SELECT `t`.`id` FROM `tasks` AS `t`
		WHERE `t`.`organisation_id` = `time_entries`.`organisation_id` AND `t`.`name_key` = 'general'
	),
	`billable` = (
		SELECT `pt`.`billable` FROM `project_tasks` AS `pt`
		JOIN `tasks` AS `t` ON `t`.`id` = `pt`.`task_id`
		WHERE `pt`.`project_id` = `time_entries`.`project_id`
			AND `t`.`organisation_id` = `time_entries`.`organisation_id`
			AND `t`.`name_key` = 'general'
	)
WHERE `task_id` IS NULL;
--> statement-breakpoint
CREATE TRIGGER `organisations_general_task`
AFTER INSERT ON `organisations`
FOR EACH ROW
BEGIN
	INSERT INTO `tasks` (`id`, `organisation_id`, `name`, `name_key`, `billable_by_default`, `common`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`id`, 'General', 'general', 1, 1, `now`, `now`
	FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`);
END;
--> statement-breakpoint
CREATE TRIGGER `projects_common_tasks`
AFTER INSERT ON `projects`
FOR EACH ROW
BEGIN
	INSERT INTO `project_tasks` (`id`, `organisation_id`, `project_id`, `task_id`, `billable`, `created_at`, `updated_at`)
	SELECT
		substr(printf('%012x', `now`), 1, 8) || '-' || substr(printf('%012x', `now`), 9, 4) || '-7'
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1)
			|| substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
		NEW.`organisation_id`, NEW.`id`, `t`.`id`,
		`t`.`billable_by_default` AND NEW.`billing_type` <> 'non_billable', `now`, `now`
	FROM `tasks` AS `t`, (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS `now`)
	WHERE `t`.`organisation_id` = NEW.`organisation_id` AND `t`.`common` = 1 AND `t`.`archived_at` IS NULL;
END;
