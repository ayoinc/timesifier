CREATE TABLE `timesheet_rule_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`overtime_policy` text NOT NULL,
	`non_working_days` text NOT NULL,
	`overtime_day_cap_minutes` integer,
	`overtime_week_cap_minutes` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "timesheet_rule_versions_overtime_policy_known" CHECK("timesheet_rule_versions"."overtime_policy" IN ('none', 'allowed', 'approval')),
	CONSTRAINT "timesheet_rule_versions_non_working_days_known" CHECK("timesheet_rule_versions"."non_working_days" IN ('overtime', 'none'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `timesheet_rule_versions_organisation_id_id_unique` ON `timesheet_rule_versions` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `timesheet_rule_versions_organisation_id_effective_from_unique` ON `timesheet_rule_versions` (`organisation_id`,`effective_from`);--> statement-breakpoint
ALTER TABLE `public_holidays` ADD `worked_by` text;