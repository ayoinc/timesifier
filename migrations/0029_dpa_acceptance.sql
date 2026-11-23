-- Who accepted the data processing agreement for an organisation, when, and
-- which version (TS-105, docs/decisions.md entry 60). Creating an organisation
-- now sets all three; an organisation made before has none until one of its
-- owners accepts in Settings. Adds only, so it ships with the code. The
-- acceptance outlives the account that gave it: deleting the account empties
-- `dpa_accepted_by` and keeps the version and the time. No row is written.
ALTER TABLE `organisations` ADD `dpa_version` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `dpa_accepted_at` integer;--> statement-breakpoint
ALTER TABLE `organisations` ADD `dpa_accepted_by` text REFERENCES users(id) ON DELETE SET NULL;
