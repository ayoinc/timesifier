-- An organisation always has at least one owner (docs/security.md, "Organisations
-- and roles"). Better Auth counts the owners and then writes in a second
-- statement, so two owners who remove or demote each other in the same instant
-- would both be let through. These two triggers make the database refuse the
-- write that would leave an organisation with members and no owner.
--
-- Written by hand: drizzle-kit has no notation for a trigger, so the schema in
-- app/db/schema.ts and the snapshots in migrations/meta say nothing of them.
--
-- An organisation is deleted by deleting its row. Its memberships go with it,
-- through the foreign key, after the row has gone, which is how the first
-- trigger tells that from an owner leaving.
CREATE TRIGGER `memberships_last_owner_stays_on_delete`
BEFORE DELETE ON `memberships`
FOR EACH ROW
WHEN OLD.`role` = 'owner'
	AND EXISTS (SELECT 1 FROM `organisations` WHERE `id` = OLD.`organisation_id`)
	AND NOT EXISTS (
		SELECT 1 FROM `memberships`
		WHERE `organisation_id` = OLD.`organisation_id` AND `role` = 'owner' AND `id` <> OLD.`id`
	)
BEGIN
	SELECT RAISE(ABORT, 'an organisation keeps at least one owner');
END;
--> statement-breakpoint
CREATE TRIGGER `memberships_last_owner_stays_on_update`
BEFORE UPDATE OF `role`, `organisation_id` ON `memberships`
FOR EACH ROW
WHEN OLD.`role` = 'owner'
	AND (NEW.`role` <> 'owner' OR NEW.`organisation_id` <> OLD.`organisation_id`)
	AND NOT EXISTS (
		SELECT 1 FROM `memberships`
		WHERE `organisation_id` = OLD.`organisation_id` AND `role` = 'owner' AND `id` <> OLD.`id`
	)
BEGIN
	SELECT RAISE(ABORT, 'an organisation keeps at least one owner');
END;
