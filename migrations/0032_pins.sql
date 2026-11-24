-- Pinned projects and people (TS-122, S2-09; docs/decisions.md entry 65).
--
-- A member pins a project to the top of Projects and of Track time's picker,
-- or a person to the top of Team. A pin is the pinner's alone, in one
-- organisation, and is one project or one person, never both. It goes with
-- the pinner's membership when they leave, with the project, and with the
-- pinned person's membership when they leave. A new table: no row is written.
CREATE TABLE `pins` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`person_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`user_id`) REFERENCES `memberships`(`organisation_id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`project_id`) REFERENCES `projects`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`person_id`) REFERENCES `memberships`(`organisation_id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pins_one_of" CHECK(("pins"."project_id" IS NULL) <> ("pins"."person_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pins_organisation_id_user_id_project_id_unique` ON `pins` (`organisation_id`,`user_id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pins_organisation_id_user_id_person_id_unique` ON `pins` (`organisation_id`,`user_id`,`person_id`);--> statement-breakpoint
CREATE INDEX `pins_organisation_id_project_id_idx` ON `pins` (`organisation_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `pins_organisation_id_person_id_idx` ON `pins` (`organisation_id`,`person_id`);