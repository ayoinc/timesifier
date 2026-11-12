CREATE TABLE `client_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`client_id` text NOT NULL,
	`name` text,
	`email` text NOT NULL,
	`email_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`client_id`) REFERENCES `clients`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "client_contacts_email_length" CHECK(length("client_contacts"."email") <= 254),
	CONSTRAINT "client_contacts_name_length" CHECK("client_contacts"."name" IS NULL OR length("client_contacts"."name") <= 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_contacts_organisation_id_id_unique` ON `client_contacts` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `client_contacts_client_email_unique` ON `client_contacts` (`organisation_id`,`client_id`,`email_key`);--> statement-breakpoint
-- An entry or an expense on an invoice line is locked until the line, its
-- draft or its invoice lets it go (docs/security.md, "Locks"; TS-073). Each
-- writer refuses first, with a sentence; these two triggers are the backstop,
-- so no path that forgets to ask can change what a client was billed for.
-- Deleting one is already refused by the foreign key from
-- `invoice_line_sources`.
--
-- Written by hand: drizzle-kit has no notation for a trigger.
CREATE TRIGGER `time_entries_invoiced_unchanged`
BEFORE UPDATE ON `time_entries`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1 FROM `invoice_line_sources`
	WHERE `organisation_id` = OLD.`organisation_id` AND `time_entry_id` = OLD.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'an invoiced entry does not change');
END;
--> statement-breakpoint
CREATE TRIGGER `expenses_invoiced_unchanged`
BEFORE UPDATE ON `expenses`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1 FROM `invoice_line_sources`
	WHERE `organisation_id` = OLD.`organisation_id` AND `expense_id` = OLD.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'an invoiced expense does not change');
END;
--> statement-breakpoint
-- An issued invoice's lines are fixed (TS-074): it can be voided, paid or
-- written off, never edited. A draft's lines change freely. When a draft or
-- an organisation is deleted its lines go after it, through the foreign key,
-- and its row is no longer there to be asked about.
CREATE TRIGGER `invoice_lines_fixed_once_issued_on_insert`
BEFORE INSERT ON `invoice_lines`
FOR EACH ROW
WHEN (
	SELECT `status` FROM `invoices`
	WHERE `organisation_id` = NEW.`organisation_id` AND `id` = NEW.`invoice_id`
) <> 'draft'
BEGIN
	SELECT RAISE(ABORT, 'an issued invoice''s lines do not change');
END;
--> statement-breakpoint
CREATE TRIGGER `invoice_lines_fixed_once_issued_on_update`
BEFORE UPDATE ON `invoice_lines`
FOR EACH ROW
WHEN (
	SELECT `status` FROM `invoices`
	WHERE `organisation_id` = OLD.`organisation_id` AND `id` = OLD.`invoice_id`
) <> 'draft'
BEGIN
	SELECT RAISE(ABORT, 'an issued invoice''s lines do not change');
END;
--> statement-breakpoint
CREATE TRIGGER `invoice_lines_fixed_once_issued_on_delete`
BEFORE DELETE ON `invoice_lines`
FOR EACH ROW
WHEN (
	SELECT `status` FROM `invoices`
	WHERE `organisation_id` = OLD.`organisation_id` AND `id` = OLD.`invoice_id`
) <> 'draft'
BEGIN
	SELECT RAISE(ABORT, 'an issued invoice''s lines do not change');
END;
--> statement-breakpoint
-- A payment or a write-off is recorded only against an issued invoice that is
-- owed something, and never for more than is owed, so its balance is never
-- below 0 (TS-074), whichever two requests arrive together.
CREATE TRIGGER `payments_within_balance`
BEFORE INSERT ON `payments`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1 FROM `invoices` AS i
	WHERE i.`organisation_id` = NEW.`organisation_id`
		AND i.`id` = NEW.`invoice_id`
		AND i.`status` IN ('sent', 'partially_paid')
		AND NEW.`amount_minor` <= i.`total_minor` - coalesce((
			SELECT sum(p.`amount_minor`) FROM `payments` AS p
			WHERE p.`organisation_id` = NEW.`organisation_id` AND p.`invoice_id` = NEW.`invoice_id`
		), 0)
)
BEGIN
	SELECT RAISE(ABORT, 'a payment is at most what is owed on an issued invoice');
END;
