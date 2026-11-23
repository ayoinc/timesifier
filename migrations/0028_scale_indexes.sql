-- Indexes for an organisation's ranges at company size (TS-113, D7,
-- docs/decisions.md entry 58). Reports, Dashboards, Wellbeing and Contractors
-- add up a range of days in SQL; the report's export and list page through it
-- in the order of day, start and id, so a wider index on the day carries the
-- start and the id and serves both. The shorter index on the day stays for
-- now, so this migration only adds and ships with the code: taking it away is
-- TS-113b's, alone. The API's list and the all-time export page through
-- everyone's entries by their start, which no index served: each page sorted
-- the organisation's history. Everyone's expenses over a range of days had
-- only a skip-scan of the index by project. No row is written.
CREATE INDEX `time_entries_organisation_id_spent_on_started_at_id_idx` ON `time_entries` (`organisation_id`,`spent_on`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `time_entries_organisation_id_started_at_id_idx` ON `time_entries` (`organisation_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `expenses_organisation_id_spent_on_id_idx` ON `expenses` (`organisation_id`,`spent_on`,`id`);
