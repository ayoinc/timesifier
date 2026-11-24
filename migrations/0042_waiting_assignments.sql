-- TS-115d, decision 77: a set-up import's assignments of people who are
-- invited and have not joined yet, applied when the invitation is accepted.
-- Only adds a table.
CREATE TABLE `invitation_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`invitation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`setup_import_id` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invitation_id`) REFERENCES `invitations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`setup_import_id`) REFERENCES `setup_imports`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invitation_assignments_role_known" CHECK("invitation_assignments"."role" IN ('member', 'delivery_manager')),
	CONSTRAINT "invitation_assignments_starts_on_is_a_day" CHECK(date("invitation_assignments"."starts_on") IS "invitation_assignments"."starts_on"),
	CONSTRAINT "invitation_assignments_ends_on_is_a_day" CHECK("invitation_assignments"."ends_on" IS NULL OR (date("invitation_assignments"."ends_on") IS "invitation_assignments"."ends_on" AND "invitation_assignments"."ends_on" >= "invitation_assignments"."starts_on"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_assignments_organisation_id_id_unique` ON `invitation_assignments` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `invitation_assignments_invitation_id_idx` ON `invitation_assignments` (`invitation_id`);--> statement-breakpoint
CREATE INDEX `invitation_assignments_organisation_id_setup_import_id_idx` ON `invitation_assignments` (`organisation_id`,`setup_import_id`);