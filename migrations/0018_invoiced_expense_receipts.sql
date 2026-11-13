-- An invoiced expense may change in one way only: by having its receipt
-- removed. Deleting an account on request (TS-099, docs/decisions.md entry 36)
-- deletes the receipts of the person's expenses that no issued invoice holds,
-- including those on a draft, and the backstop of 0016 refused that as it
-- refused every change. It still refuses every other change of an invoiced
-- expense: a billed column changed, or a receipt put on or replaced. Only
-- `updated_at` may change alongside the receipt going.
--
-- Written by hand: drizzle-kit has no notation for a trigger.
DROP TRIGGER `expenses_invoiced_unchanged`;
--> statement-breakpoint
CREATE TRIGGER `expenses_invoiced_unchanged`
BEFORE UPDATE ON `expenses`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1 FROM `invoice_line_sources`
	WHERE `organisation_id` = OLD.`organisation_id` AND `expense_id` = OLD.`id`
)
AND NOT (
	NEW.`id` IS OLD.`id`
	AND NEW.`organisation_id` IS OLD.`organisation_id`
	AND NEW.`user_id` IS OLD.`user_id`
	AND NEW.`project_id` IS OLD.`project_id`
	AND NEW.`category_id` IS OLD.`category_id`
	AND NEW.`spent_on` IS OLD.`spent_on`
	AND NEW.`amount_minor` IS OLD.`amount_minor`
	AND NEW.`currency` IS OLD.`currency`
	AND NEW.`quantity_milli` IS OLD.`quantity_milli`
	AND NEW.`unit_price_minor` IS OLD.`unit_price_minor`
	AND NEW.`billable` IS OLD.`billable`
	AND NEW.`reimbursable` IS OLD.`reimbursable`
	AND NEW.`notes` IS OLD.`notes`
	AND NEW.`created_at` IS OLD.`created_at`
	AND NEW.`receipt_key` IS NULL
	AND NEW.`receipt_name` IS NULL
	AND NEW.`receipt_type` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'an invoiced expense does not change');
END;
