-- Expected hours as a ceiling, overtime recorded as such (TS-095).
--
-- An entry is regular time or overtime: every entry made before this
-- migration is regular. Each organisation's overtime rule and its rule for
-- days the working week does not work are new columns, so every existing
-- organisation, as each new one, starts with overtime not allowed and time on
-- a day not worked counted as overtime: the owner's decision of 2026-11-12.
-- TS-090's `overtime_rule` and `weekend_rule` are no longer read; a later
-- migration, which ships alone, takes them away.
ALTER TABLE `time_entries` ADD `overtime` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `overtime_policy` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `non_working_days` text DEFAULT 'overtime' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `overtime_day_cap_minutes` integer;--> statement-breakpoint
ALTER TABLE `organisations` ADD `overtime_week_cap_minutes` integer;
