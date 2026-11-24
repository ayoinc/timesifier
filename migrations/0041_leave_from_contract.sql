-- Leave from the contract (TS-098b; docs/decisions.md entry 76;
-- research/contracts-model.md sections 2, 3 and 8).
--
-- Additive: one new table and five columns added in place, so no table is
-- rebuilt and nothing existing changes. Every organisation keeps a leave year
-- from 1 January, counts a starter's month from their first day, and keeps
-- public holidays on top of annual leave, as before (the owner's answer 2).
-- Every contract version carries nothing over, as before.
--
-- The new columns' bounds are CHECKs on the columns, which SQLite adds in
-- place: a CHECK on the table, as drizzle-kit would write it, rebuilds the
-- table. The snapshot is drizzle-kit's for the columns; the CHECKs are
-- written by hand, as in 0025. `leave_year_starts` is a day of every year:
-- 2001 was not a leap year, so 29 February is refused.
CREATE TABLE `leave_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind_id` text NOT NULL,
	`leave_year` integer NOT NULL,
	`minutes` integer NOT NULL,
	`reason` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organisation_id`,`user_id`) REFERENCES `memberships`(`organisation_id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`kind_id`) REFERENCES `leave_kinds`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "leave_adjustments_year_in_range" CHECK("leave_adjustments"."leave_year" BETWEEN 2000 AND 2200),
	CONSTRAINT "leave_adjustments_minutes_in_range" CHECK("leave_adjustments"."minutes" <> 0 AND "leave_adjustments"."minutes" BETWEEN -527040 AND 527040),
	CONSTRAINT "leave_adjustments_reason_length" CHECK(length(trim("leave_adjustments"."reason")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leave_adjustments_organisation_id_id_unique` ON `leave_adjustments` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `leave_adjustments_organisation_id_user_id_leave_year_index` ON `leave_adjustments` (`organisation_id`,`user_id`,`leave_year`);--> statement-breakpoint
ALTER TABLE `contract_versions` ADD `carry_over_days` integer DEFAULT 0 NOT NULL CHECK (`carry_over_days` BETWEEN 0 AND 366);--> statement-breakpoint
ALTER TABLE `contract_versions` ADD `carry_over_expires_after_days` integer CHECK (`carry_over_expires_after_days` IS NULL OR `carry_over_expires_after_days` BETWEEN 1 AND 366);--> statement-breakpoint
ALTER TABLE `organisations` ADD `leave_year_starts` text DEFAULT '01-01' NOT NULL CHECK (`leave_year_starts` GLOB '[01][0-9]-[0-3][0-9]' AND date('2001-' || `leave_year_starts`) IS '2001-' || `leave_year_starts`);--> statement-breakpoint
ALTER TABLE `organisations` ADD `starter_month` text DEFAULT 'days' NOT NULL CHECK (`starter_month` IN ('days', 'whole'));--> statement-breakpoint
ALTER TABLE `organisations` ADD `holidays_from_allowance` integer DEFAULT false NOT NULL CHECK (`holidays_from_allowance` IN (0, 1));
