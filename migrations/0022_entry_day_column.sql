-- The day an entry belongs to, stored (TS-111, docs/decisions.md entry 39).
-- This migration only makes room for it. The column is added empty, so the
-- Worker running now, which does not write it, can still write entries; the
-- next migration fills every entry's day from its start in its person's zone,
-- and from then on the Worker writes the day with each entry.
--
-- Filling the day is an update of every entry, invoiced ones too, and the
-- backstop of 0016 refuses every change of an invoiced entry. It is put back
-- refusing every change but one: an invoiced entry's empty day may be written,
-- once, with a real date, and nothing else of the row may change with it,
-- `updated_at` included.
--
-- `app/db/schema.ts` does not name the column yet, so the Worker's inserts
-- leave it to its default and bind no more values than before (D1 binds at
-- most 100 to a statement). TS-111b names it, with this migration's snapshot.
--
-- Written by hand: drizzle-kit has no notation for a trigger.
ALTER TABLE `time_entries` ADD `spent_on` text DEFAULT '' NOT NULL;
--> statement-breakpoint
DROP TRIGGER `time_entries_invoiced_unchanged`;
--> statement-breakpoint
CREATE TRIGGER `time_entries_invoiced_unchanged`
BEFORE UPDATE ON `time_entries`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1 FROM `invoice_line_sources`
	WHERE `organisation_id` = OLD.`organisation_id` AND `time_entry_id` = OLD.`id`
)
AND NOT (
	OLD.`spent_on` = ''
	AND date(NEW.`spent_on`) IS NEW.`spent_on`
	AND NEW.`id` IS OLD.`id`
	AND NEW.`organisation_id` IS OLD.`organisation_id`
	AND NEW.`user_id` IS OLD.`user_id`
	AND NEW.`project_id` IS OLD.`project_id`
	AND NEW.`description` IS OLD.`description`
	AND NEW.`started_at` IS OLD.`started_at`
	AND NEW.`ended_at` IS OLD.`ended_at`
	AND NEW.`task_id` IS OLD.`task_id`
	AND NEW.`billable` IS OLD.`billable`
	AND NEW.`import_id` IS OLD.`import_id`
	AND NEW.`overtime` IS OLD.`overtime`
	AND NEW.`created_at` IS OLD.`created_at`
	AND NEW.`updated_at` IS OLD.`updated_at`
)
BEGIN
	SELECT RAISE(ABORT, 'an invoiced entry does not change');
END;
