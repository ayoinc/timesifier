CREATE TABLE `activity_records` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`actor_id` text,
	`source` text DEFAULT 'web' NOT NULL,
	`action` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`owner_id` text,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_records_source_known" CHECK("activity_records"."source" IN ('web', 'api', 'import', 'system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_records_organisation_id_id_unique` ON `activity_records` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `activity_records_organisation_id_created_at_idx` ON `activity_records` (`organisation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_records_organisation_id_subject_idx` ON `activity_records` (`organisation_id`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `activity_records_organisation_id_owner_id_created_at_idx` ON `activity_records` (`organisation_id`,`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`scopes` text NOT NULL,
	`created_by` text NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "api_tokens_prefix_length" CHECK(length("api_tokens"."prefix") = 8)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_organisation_id_id_unique` ON `api_tokens` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `budget_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`period_starts_on` text NOT NULL,
	`threshold_percent` integer NOT NULL,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "budget_alerts_threshold_positive" CHECK("budget_alerts"."threshold_percent" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_alerts_organisation_id_id_unique` ON `budget_alerts` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `budget_alerts_project_id_period_threshold_unique` ON `budget_alerts` (`project_id`,`period_starts_on`,`threshold_percent`);--> statement-breakpoint
CREATE TABLE `budget_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`user_id` text,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`task_id`) REFERENCES `tasks`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "budget_lines_task_or_person" CHECK(("budget_lines"."task_id" IS NULL) <> ("budget_lines"."user_id" IS NULL)),
	CONSTRAINT "budget_lines_amount_not_negative" CHECK("budget_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_lines_organisation_id_id_unique` ON `budget_lines` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `budget_lines_project_id_task_id_unique` ON `budget_lines` (`project_id`,`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `budget_lines_project_id_user_id_unique` ON `budget_lines` (`project_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `budget_lines_organisation_id_project_id_idx` ON `budget_lines` (`organisation_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `calendar_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`team_id` text,
	`token_hash` text NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`user_id`) REFERENCES `memberships`(`organisation_id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`team_id`) REFERENCES `teams`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "calendar_feeds_kind_known" CHECK("calendar_feeds"."kind" IN ('person', 'team')),
	CONSTRAINT "calendar_feeds_team_for_team_kind" CHECK(("calendar_feeds"."kind" = 'team') = ("calendar_feeds"."team_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_feeds_organisation_id_id_unique` ON `calendar_feeds` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_feeds_token_hash_unique` ON `calendar_feeds` (`token_hash`);--> statement-breakpoint
CREATE INDEX `calendar_feeds_organisation_id_user_id_idx` ON `calendar_feeds` (`organisation_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `entry_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`time_entry_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`time_entry_id`) REFERENCES `time_entries`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`tag_id`) REFERENCES `tags`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entry_tags_organisation_id_id_unique` ON `entry_tags` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `entry_tags_time_entry_id_tag_id_unique` ON `entry_tags` (`time_entry_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `entry_tags_organisation_id_tag_id_idx` ON `entry_tags` (`organisation_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `estimate_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`estimate_id` text NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`quantity_milli` integer NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`tax_id` text,
	`second_tax_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`estimate_id`) REFERENCES `estimates`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`tax_id`) REFERENCES `taxes`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`second_tax_id`) REFERENCES `taxes`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "estimate_lines_position_not_negative" CHECK("estimate_lines"."position" >= 0),
	CONSTRAINT "estimate_lines_second_tax_after_first" CHECK("estimate_lines"."second_tax_id" IS NULL OR ("estimate_lines"."tax_id" IS NOT NULL AND "estimate_lines"."second_tax_id" <> "estimate_lines"."tax_id"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `estimate_lines_organisation_id_id_unique` ON `estimate_lines` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `estimate_lines_organisation_id_estimate_id_position_idx` ON `estimate_lines` (`organisation_id`,`estimate_id`,`position`);--> statement-breakpoint
CREATE TABLE `estimates` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`number` text NOT NULL,
	`client_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`currency` text NOT NULL,
	`issued_on` text NOT NULL,
	`po_number` text,
	`subject` text,
	`notes` text,
	`discount_basis_points` integer DEFAULT 0 NOT NULL,
	`subtotal_minor` integer DEFAULT 0 NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`tax_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer DEFAULT 0 NOT NULL,
	`sent_at` integer,
	`decided_at` integer,
	`invoice_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`client_id`) REFERENCES `clients`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`invoice_id`) REFERENCES `invoices`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "estimates_status_known" CHECK("estimates"."status" IN ('draft', 'sent', 'accepted', 'declined')),
	CONSTRAINT "estimates_currency_code" CHECK("estimates"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "estimates_discount_in_range" CHECK("estimates"."discount_basis_points" >= 0 AND "estimates"."discount_basis_points" <= 10000 AND "estimates"."discount_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `estimates_organisation_id_id_unique` ON `estimates` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `estimates_organisation_id_number_unique` ON `estimates` (`organisation_id`,`number`);--> statement-breakpoint
CREATE INDEX `estimates_organisation_id_client_id_issued_on_idx` ON `estimates` (`organisation_id`,`client_id`,`issued_on`);--> statement-breakpoint
CREATE TABLE `expense_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`unit_name` text,
	`unit_price_minor` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "expense_categories_unit_with_price" CHECK(("expense_categories"."unit_name" IS NULL) = ("expense_categories"."unit_price_minor" IS NULL)),
	CONSTRAINT "expense_categories_unit_price_not_negative" CHECK("expense_categories"."unit_price_minor" IS NULL OR "expense_categories"."unit_price_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_categories_organisation_id_id_unique` ON `expense_categories` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `expense_categories_organisation_id_name_key_unique` ON `expense_categories` (`organisation_id`,`name_key`);--> statement-breakpoint
CREATE TABLE `expense_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`expense_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`expense_id`) REFERENCES `expenses`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`tag_id`) REFERENCES `tags`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_tags_organisation_id_id_unique` ON `expense_tags` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `expense_tags_expense_id_tag_id_unique` ON `expense_tags` (`expense_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `expense_tags_organisation_id_tag_id_idx` ON `expense_tags` (`organisation_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`category_id` text NOT NULL,
	`spent_on` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`quantity_milli` integer,
	`unit_price_minor` integer,
	`billable` integer DEFAULT false NOT NULL,
	`reimbursable` integer DEFAULT false NOT NULL,
	`notes` text,
	`receipt_key` text,
	`receipt_name` text,
	`receipt_type` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`category_id`) REFERENCES `expense_categories`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "expenses_amount_not_negative" CHECK("expenses"."amount_minor" >= 0),
	CONSTRAINT "expenses_currency_code" CHECK("expenses"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "expenses_quantity_with_unit_price" CHECK(("expenses"."quantity_milli" IS NULL) = ("expenses"."unit_price_minor" IS NULL)),
	CONSTRAINT "expenses_quantity_positive" CHECK("expenses"."quantity_milli" IS NULL OR "expenses"."quantity_milli" > 0),
	CONSTRAINT "expenses_unit_price_not_negative" CHECK("expenses"."unit_price_minor" IS NULL OR "expenses"."unit_price_minor" >= 0),
	CONSTRAINT "expenses_notes_length" CHECK("expenses"."notes" IS NULL OR length("expenses"."notes") <= 500),
	CONSTRAINT "expenses_receipt_whole" CHECK(("expenses"."receipt_key" IS NULL) = ("expenses"."receipt_name" IS NULL) AND ("expenses"."receipt_key" IS NULL) = ("expenses"."receipt_type" IS NULL)),
	CONSTRAINT "expenses_receipt_type_known" CHECK("expenses"."receipt_type" IS NULL OR "expenses"."receipt_type" IN ('application/pdf', 'image/png', 'image/jpeg'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_organisation_id_id_unique` ON `expenses` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `expenses_organisation_id_user_id_spent_on_idx` ON `expenses` (`organisation_id`,`user_id`,`spent_on`);--> statement-breakpoint
CREATE INDEX `expenses_organisation_id_project_id_spent_on_idx` ON `expenses` (`organisation_id`,`project_id`,`spent_on`);--> statement-breakpoint
CREATE INDEX `expenses_organisation_id_category_id_idx` ON `expenses` (`organisation_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'previewed' NOT NULL,
	`file_name` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`imported_at` integer,
	`reverted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "import_jobs_kind_known" CHECK("import_jobs"."kind" IN ('time', 'clients', 'projects', 'expenses')),
	CONSTRAINT "import_jobs_status_known" CHECK("import_jobs"."status" IN ('previewed', 'imported', 'reverted', 'failed')),
	CONSTRAINT "import_jobs_counts_not_negative" CHECK("import_jobs"."row_count" >= 0 AND "import_jobs"."imported_count" >= 0 AND "import_jobs"."skipped_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_jobs_organisation_id_id_unique` ON `import_jobs` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `import_jobs_organisation_id_created_at_idx` ON `import_jobs` (`organisation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `invoice_line_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`line_id` text NOT NULL,
	`time_entry_id` text,
	`expense_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`line_id`) REFERENCES `invoice_lines`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`time_entry_id`) REFERENCES `time_entries`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`expense_id`) REFERENCES `expenses`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoice_line_sources_entry_or_expense" CHECK(("invoice_line_sources"."time_entry_id" IS NULL) <> ("invoice_line_sources"."expense_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_line_sources_organisation_id_id_unique` ON `invoice_line_sources` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_line_sources_organisation_id_time_entry_id_unique` ON `invoice_line_sources` (`organisation_id`,`time_entry_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_line_sources_organisation_id_expense_id_unique` ON `invoice_line_sources` (`organisation_id`,`expense_id`);--> statement-breakpoint
CREATE INDEX `invoice_line_sources_organisation_id_line_id_idx` ON `invoice_line_sources` (`organisation_id`,`line_id`);--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`project_id` text,
	`quantity_milli` integer NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`tax_id` text,
	`second_tax_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`invoice_id`) REFERENCES `invoices`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`tax_id`) REFERENCES `taxes`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`second_tax_id`) REFERENCES `taxes`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoice_lines_kind_known" CHECK("invoice_lines"."kind" IN ('time', 'expense', 'fixed', 'manual')),
	CONSTRAINT "invoice_lines_position_not_negative" CHECK("invoice_lines"."position" >= 0),
	CONSTRAINT "invoice_lines_second_tax_after_first" CHECK("invoice_lines"."second_tax_id" IS NULL OR ("invoice_lines"."tax_id" IS NOT NULL AND "invoice_lines"."second_tax_id" <> "invoice_lines"."tax_id"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_lines_organisation_id_id_unique` ON `invoice_lines` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `invoice_lines_organisation_id_invoice_id_position_idx` ON `invoice_lines` (`organisation_id`,`invoice_id`,`position`);--> statement-breakpoint
CREATE TABLE `invoice_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`legal_name` text,
	`address` text,
	`tax_number` text,
	`payment_terms_days` integer DEFAULT 30 NOT NULL,
	`default_notes` text,
	`next_invoice_number` integer DEFAULT 1 NOT NULL,
	`next_estimate_number` integer DEFAULT 1 NOT NULL,
	`late_reminder_after_days` integer,
	`late_reminder_every_days` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invoice_settings_payment_terms_not_negative" CHECK("invoice_settings"."payment_terms_days" >= 0),
	CONSTRAINT "invoice_settings_numbers_positive" CHECK("invoice_settings"."next_invoice_number" >= 1 AND "invoice_settings"."next_estimate_number" >= 1),
	CONSTRAINT "invoice_settings_reminders_positive" CHECK(("invoice_settings"."late_reminder_after_days" IS NULL OR "invoice_settings"."late_reminder_after_days" >= 0) AND ("invoice_settings"."late_reminder_every_days" IS NULL OR "invoice_settings"."late_reminder_every_days" >= 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_settings_organisation_id_id_unique` ON `invoice_settings` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_settings_organisation_id_unique` ON `invoice_settings` (`organisation_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`number` text NOT NULL,
	`client_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`currency` text NOT NULL,
	`issued_on` text NOT NULL,
	`due_on` text NOT NULL,
	`po_number` text,
	`subject` text,
	`notes` text,
	`discount_basis_points` integer DEFAULT 0 NOT NULL,
	`subtotal_minor` integer DEFAULT 0 NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`tax_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer DEFAULT 0 NOT NULL,
	`sent_at` integer,
	`voided_at` integer,
	`retainer_id` text,
	`recurring_invoice_id` text,
	`estimate_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`client_id`) REFERENCES `clients`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`retainer_id`) REFERENCES `retainers`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`recurring_invoice_id`) REFERENCES `recurring_invoices`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`estimate_id`) REFERENCES `estimates`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoices_status_known" CHECK("invoices"."status" IN ('draft', 'sent', 'partially_paid', 'paid', 'void')),
	CONSTRAINT "invoices_currency_code" CHECK("invoices"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "invoices_due_on_or_after_issue" CHECK("invoices"."due_on" >= "invoices"."issued_on"),
	CONSTRAINT "invoices_discount_in_range" CHECK("invoices"."discount_basis_points" >= 0 AND "invoices"."discount_basis_points" <= 10000 AND "invoices"."discount_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_organisation_id_id_unique` ON `invoices` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_organisation_id_number_unique` ON `invoices` (`organisation_id`,`number`);--> statement-breakpoint
CREATE INDEX `invoices_organisation_id_client_id_issued_on_idx` ON `invoices` (`organisation_id`,`client_id`,`issued_on`);--> statement-breakpoint
CREATE INDEX `invoices_organisation_id_status_due_on_idx` ON `invoices` (`organisation_id`,`status`,`due_on`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`paid_on` text NOT NULL,
	`method` text,
	`note` text,
	`recorded_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`invoice_id`) REFERENCES `invoices`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_kind_known" CHECK("payments"."kind" IN ('payment', 'write_off')),
	CONSTRAINT "payments_amount_positive" CHECK("payments"."amount_minor" > 0),
	CONSTRAINT "payments_method_known" CHECK("payments"."method" IS NULL OR ("payments"."kind" = 'payment' AND "payments"."method" IN ('bank_transfer', 'card', 'cash', 'cheque', 'other')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_organisation_id_id_unique` ON `payments` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `payments_organisation_id_invoice_id_idx` ON `payments` (`organisation_id`,`invoice_id`);--> statement-breakpoint
CREATE INDEX `payments_organisation_id_paid_on_idx` ON `payments` (`organisation_id`,`paid_on`);--> statement-breakpoint
CREATE TABLE `project_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`tag_id`) REFERENCES `tags`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_tags_organisation_id_id_unique` ON `project_tags` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_tags_project_id_tag_id_unique` ON `project_tags` (`project_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `project_tags_organisation_id_tag_id_idx` ON `project_tags` (`organisation_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `project_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`billable` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`task_id`) REFERENCES `tasks`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_tasks_organisation_id_id_unique` ON `project_tasks` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_tasks_project_id_task_id_unique` ON `project_tasks` (`project_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `project_tasks_organisation_id_task_id_idx` ON `project_tasks` (`organisation_id`,`task_id`);--> statement-breakpoint
CREATE TABLE `rates` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`project_id` text,
	`task_id` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`effective_from` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`task_id`) REFERENCES `tasks`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rates_kind_known" CHECK("rates"."kind" IN ('billable', 'cost')),
	CONSTRAINT "rates_not_person_and_task" CHECK("rates"."user_id" IS NULL OR "rates"."task_id" IS NULL),
	CONSTRAINT "rates_amount_not_negative" CHECK("rates"."amount_minor" >= 0),
	CONSTRAINT "rates_currency_code" CHECK("rates"."currency" GLOB '[A-Z][A-Z][A-Z]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rates_organisation_id_id_unique` ON `rates` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `rates_organisation_default_unique` ON `rates` (`organisation_id`,`kind`,`effective_from`) WHERE "rates"."user_id" IS NULL AND "rates"."project_id" IS NULL AND "rates"."task_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `rates_person_unique` ON `rates` (`organisation_id`,`kind`,`user_id`,`effective_from`) WHERE "rates"."project_id" IS NULL AND "rates"."task_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `rates_project_unique` ON `rates` (`organisation_id`,`kind`,`project_id`,`effective_from`) WHERE "rates"."user_id" IS NULL AND "rates"."task_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `rates_project_person_unique` ON `rates` (`organisation_id`,`kind`,`project_id`,`user_id`,`effective_from`) WHERE "rates"."task_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `rates_task_unique` ON `rates` (`organisation_id`,`kind`,`task_id`,`effective_from`) WHERE "rates"."user_id" IS NULL AND "rates"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `rates_project_task_unique` ON `rates` (`organisation_id`,`kind`,`project_id`,`task_id`,`effective_from`) WHERE "rates"."user_id" IS NULL;--> statement-breakpoint
CREATE INDEX `rates_organisation_id_project_id_idx` ON `rates` (`organisation_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `recurring_invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`recurring_invoice_id` text NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`quantity_milli` integer NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`tax_id` text,
	`second_tax_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`recurring_invoice_id`) REFERENCES `recurring_invoices`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`tax_id`) REFERENCES `taxes`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`second_tax_id`) REFERENCES `taxes`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_invoice_lines_position_not_negative" CHECK("recurring_invoice_lines"."position" >= 0),
	CONSTRAINT "recurring_invoice_lines_second_tax_after_first" CHECK("recurring_invoice_lines"."second_tax_id" IS NULL OR ("recurring_invoice_lines"."tax_id" IS NOT NULL AND "recurring_invoice_lines"."second_tax_id" <> "recurring_invoice_lines"."tax_id"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_invoice_lines_organisation_id_id_unique` ON `recurring_invoice_lines` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `recurring_invoice_lines_organisation_id_recurring_invoice_id_idx` ON `recurring_invoice_lines` (`organisation_id`,`recurring_invoice_id`,`position`);--> statement-breakpoint
CREATE TABLE `recurring_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`client_id` text NOT NULL,
	`frequency` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`next_issue_on` text NOT NULL,
	`send_automatically` integer DEFAULT false NOT NULL,
	`include_uninvoiced_time` integer DEFAULT false NOT NULL,
	`currency` text NOT NULL,
	`payment_terms_days` integer DEFAULT 30 NOT NULL,
	`subject` text,
	`notes` text,
	`stopped_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`client_id`) REFERENCES `clients`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_invoices_frequency_known" CHECK("recurring_invoices"."frequency" IN ('monthly', 'quarterly', 'yearly')),
	CONSTRAINT "recurring_invoices_ends_on_or_after_start" CHECK("recurring_invoices"."ends_on" IS NULL OR "recurring_invoices"."ends_on" >= "recurring_invoices"."starts_on"),
	CONSTRAINT "recurring_invoices_currency_code" CHECK("recurring_invoices"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "recurring_invoices_payment_terms_not_negative" CHECK("recurring_invoices"."payment_terms_days" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_invoices_organisation_id_id_unique` ON `recurring_invoices` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `recurring_invoices_next_issue_on_idx` ON `recurring_invoices` (`next_issue_on`);--> statement-breakpoint
CREATE INDEX `recurring_invoices_organisation_id_client_id_idx` ON `recurring_invoices` (`organisation_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `retainer_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`retainer_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`invoice_id` text,
	`occurred_on` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`retainer_id`) REFERENCES `retainers`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`invoice_id`) REFERENCES `invoices`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "retainer_movements_kind_known" CHECK("retainer_movements"."kind" IN ('deposit', 'draw')),
	CONSTRAINT "retainer_movements_amount_positive" CHECK("retainer_movements"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retainer_movements_organisation_id_id_unique` ON `retainer_movements` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `retainer_movements_organisation_id_retainer_id_occurred_on_idx` ON `retainer_movements` (`organisation_id`,`retainer_id`,`occurred_on`);--> statement-breakpoint
CREATE TABLE `retainers` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`client_id` text NOT NULL,
	`project_id` text,
	`currency` text NOT NULL,
	`balance_minor` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`client_id`) REFERENCES `clients`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "retainers_currency_code" CHECK("retainers"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "retainers_balance_not_negative" CHECK("retainers"."balance_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retainers_organisation_id_id_unique` ON `retainers` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `retainers_client_unique` ON `retainers` (`organisation_id`,`client_id`) WHERE "retainers"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `retainers_client_project_unique` ON `retainers` (`organisation_id`,`client_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `saved_report_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`report_id` text NOT NULL,
	`user_id` text NOT NULL,
	`can_edit` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`report_id`) REFERENCES `saved_reports`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`user_id`) REFERENCES `memberships`(`organisation_id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_report_shares_organisation_id_id_unique` ON `saved_report_shares` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `saved_report_shares_report_id_user_id_unique` ON `saved_report_shares` (`report_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `saved_report_shares_organisation_id_user_id_idx` ON `saved_report_shares` (`organisation_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `saved_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`query` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`owner_id`) REFERENCES `memberships`(`organisation_id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_reports_organisation_id_id_unique` ON `saved_reports` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `saved_reports_organisation_id_owner_id_idx` ON `saved_reports` (`organisation_id`,`owner_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_organisation_id_id_unique` ON `tags` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_organisation_id_name_key_unique` ON `tags` (`organisation_id`,`name_key`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`billable_by_default` integer DEFAULT true NOT NULL,
	`common` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_organisation_id_id_unique` ON `tasks` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_organisation_id_name_key_unique` ON `tasks` (`organisation_id`,`name_key`);--> statement-breakpoint
CREATE TABLE `taxes` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`name` text NOT NULL,
	`rate_basis_points` integer NOT NULL,
	`compound` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "taxes_rate_in_range" CHECK("taxes"."rate_basis_points" >= 0 AND "taxes"."rate_basis_points" <= 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxes_organisation_id_id_unique` ON `taxes` (`organisation_id`,`id`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`secret_hash` text NOT NULL,
	`secret_version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_delivered_at` integer,
	`last_status` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhooks_secret_version_positive" CHECK("webhooks"."secret_version" >= 1),
	CONSTRAINT "webhooks_failures_not_negative" CHECK("webhooks"."failures" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhooks_organisation_id_id_unique` ON `webhooks` (`organisation_id`,`id`);--> statement-breakpoint
ALTER TABLE `clients` ADD `currency` text;--> statement-breakpoint
ALTER TABLE `memberships` ADD `is_contractor` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `currency` text DEFAULT 'GBP' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `locked_through` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `deadline_kind` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `deadline_day` integer;--> statement-breakpoint
ALTER TABLE `organisations` ADD `deadline_time` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `auto_lock_days` integer;--> statement-breakpoint
ALTER TABLE `organisations` ADD `budget_counts_non_billable` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `billing_type` text DEFAULT 'hourly' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `rate_mode` text DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `fee_minor` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `currency` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `budget_kind` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `budget_amount` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `budget_resets_monthly` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `budget_alert_percent` integer DEFAULT 80;--> statement-breakpoint
ALTER TABLE `projects` ADD `budget_warn_members` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `budget_includes_expenses` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `time_entries` ADD `task_id` text;--> statement-breakpoint
ALTER TABLE `time_entries` ADD `billable` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `time_entries` ADD `import_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `time_entries_organisation_id_id_unique` ON `time_entries` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `time_entries_organisation_id_task_id_idx` ON `time_entries` (`organisation_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `time_entries_organisation_id_import_id_idx` ON `time_entries` (`organisation_id`,`import_id`);--> statement-breakpoint
-- By hand: the activity log is append-only (docs/security.md, "Activity log").
-- Rows are deleted when they are 730 days old; none is ever changed.
CREATE TRIGGER `activity_records_append_only`
BEFORE UPDATE ON `activity_records`
BEGIN
	SELECT RAISE(ABORT, 'activity records are never changed');
END;
