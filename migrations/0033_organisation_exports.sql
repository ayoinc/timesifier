-- Exports of everything an organisation holds (TS-126; docs/decisions.md entry
-- 71). An owner asks for one; it is made a step at a time, by the request and
-- then the every-minute trigger, into one ZIP in R2, and its row and its file
-- are deleted 7 days after it is ready. The status index is how the triggers
-- find the exports running and those past their 7 days, in every
-- organisation. A new table: no row is written. Numbered 0035 after #100's
-- 0033 and #102's 0034; renumbered at merge if those have not landed.
CREATE TABLE `organisation_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`requested_by` text,
	`status` text DEFAULT 'running' NOT NULL,
	`progress` text NOT NULL,
	`upload_id` text,
	`parts` text DEFAULT '[]' NOT NULL,
	`size` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`finished_at` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "organisation_exports_status" CHECK("organisation_exports"."status" in ('running', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organisation_exports_organisation_id_id_unique` ON `organisation_exports` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `organisation_exports_status_expires_at_idx` ON `organisation_exports` (`status`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `organisation_exports_running_unique` ON `organisation_exports` (`organisation_id`) WHERE status = 'running';