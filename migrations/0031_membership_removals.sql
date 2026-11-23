CREATE TABLE `membership_removals` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`removed_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`removed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `membership_removals_organisation_id_id_unique` ON `membership_removals` (`organisation_id`,`id`);--> statement-breakpoint
CREATE INDEX `membership_removals_organisation_id_user_id_idx` ON `membership_removals` (`organisation_id`,`user_id`);