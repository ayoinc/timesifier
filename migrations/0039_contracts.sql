CREATE TABLE `contract_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`contract_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`job_title` text,
	`schedule_id` text,
	`pay_basis` text NOT NULL,
	`pay_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`overtime_pay` text DEFAULT 'unpaid' NOT NULL,
	`overtime_multiplier_bp` integer,
	`rest_day_multiplier_bp` integer,
	`leave_days` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organisation_id`,`contract_id`) REFERENCES `contracts`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`schedule_id`) REFERENCES `work_schedules`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "contract_versions_effective_from_is_a_day" CHECK(date("contract_versions"."effective_from") IS "contract_versions"."effective_from"),
	CONSTRAINT "contract_versions_job_title_length" CHECK("contract_versions"."job_title" IS NULL OR length("contract_versions"."job_title") BETWEEN 1 AND 100),
	CONSTRAINT "contract_versions_pay_basis_known" CHECK("contract_versions"."pay_basis" IN ('yearly', 'hourly', 'daily')),
	CONSTRAINT "contract_versions_pay_not_negative" CHECK("contract_versions"."pay_minor" >= 0),
	CONSTRAINT "contract_versions_currency_is_a_code" CHECK("contract_versions"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "contract_versions_overtime_pay_known" CHECK("contract_versions"."overtime_pay" IN ('unpaid', 'paid', 'toil')),
	CONSTRAINT "contract_versions_overtime_multiplier_known" CHECK("contract_versions"."overtime_multiplier_bp" IS NULL OR "contract_versions"."overtime_multiplier_bp" IN (10000, 12500, 13333, 15000, 20000, 30000, 40000)),
	CONSTRAINT "contract_versions_rest_day_multiplier_known" CHECK("contract_versions"."rest_day_multiplier_bp" IS NULL OR "contract_versions"."rest_day_multiplier_bp" IN (10000, 12500, 13333, 15000, 20000, 30000, 40000)),
	CONSTRAINT "contract_versions_leave_days_in_range" CHECK("contract_versions"."leave_days" IS NULL OR "contract_versions"."leave_days" BETWEEN 0 AND 366)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contract_versions_organisation_id_id_unique` ON `contract_versions` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `contract_versions_contract_id_effective_from_unique` ON `contract_versions` (`organisation_id`,`contract_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`end_reason` text,
	`works_number` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "contracts_kind_known" CHECK("contracts"."kind" IN ('permanent', 'fixed_term', 'contractor', 'irregular')),
	CONSTRAINT "contracts_starts_on_is_a_day" CHECK(date("contracts"."starts_on") IS "contracts"."starts_on"),
	CONSTRAINT "contracts_ends_on_is_a_day" CHECK("contracts"."ends_on" IS NULL OR (date("contracts"."ends_on") IS "contracts"."ends_on" AND "contracts"."ends_on" >= "contracts"."starts_on")),
	CONSTRAINT "contracts_fixed_term_ends" CHECK("contracts"."kind" <> 'fixed_term' OR "contracts"."ends_on" IS NOT NULL),
	CONSTRAINT "contracts_end_reason_known" CHECK("contracts"."end_reason" IS NULL OR "contracts"."end_reason" IN ('resigned', 'dismissed', 'end_of_term', 'replaced')),
	CONSTRAINT "contracts_works_number_length" CHECK("contracts"."works_number" IS NULL OR length("contracts"."works_number") BETWEEN 1 AND 35)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contracts_organisation_id_id_unique` ON `contracts` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `contracts_organisation_id_user_id_starts_on_index` ON `contracts` (`organisation_id`,`user_id`,`starts_on`);--> statement-breakpoint
-- No two contracts of one person in one organisation share a day (TS-098a).
-- The server refuses an overlap first and says why; these refuse the one a
-- race lets through. An open contract runs to the end of time.
CREATE TRIGGER `contracts_no_overlap_insert`
BEFORE INSERT ON `contracts`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1 FROM `contracts` AS `other`
	WHERE `other`.`organisation_id` = NEW.`organisation_id`
		AND `other`.`user_id` = NEW.`user_id`
		AND `other`.`starts_on` <= coalesce(NEW.`ends_on`, '9999-12-31')
		AND NEW.`starts_on` <= coalesce(`other`.`ends_on`, '9999-12-31')
)
BEGIN
	SELECT RAISE(ABORT, 'a person''s contracts never overlap');
END;
--> statement-breakpoint
CREATE TRIGGER `contracts_no_overlap_update`
BEFORE UPDATE OF `organisation_id`, `user_id`, `starts_on`, `ends_on` ON `contracts`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1 FROM `contracts` AS `other`
	WHERE `other`.`organisation_id` = NEW.`organisation_id`
		AND `other`.`user_id` = NEW.`user_id`
		AND `other`.`id` <> OLD.`id`
		AND `other`.`starts_on` <= coalesce(NEW.`ends_on`, '9999-12-31')
		AND NEW.`starts_on` <= coalesce(`other`.`ends_on`, '9999-12-31')
)
BEGIN
	SELECT RAISE(ABORT, 'a person''s contracts never overlap');
END;
