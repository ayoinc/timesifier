CREATE TABLE `organisation_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`domain` text NOT NULL,
	`token` text NOT NULL,
	`verified_at` integer,
	`last_seen_at` integer,
	`self_join` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organisation_domains_domain_lower_case" CHECK("organisation_domains"."domain" = lower("organisation_domains"."domain"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organisation_domains_organisation_id_id_unique` ON `organisation_domains` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organisation_domains_organisation_id_domain_unique` ON `organisation_domains` (`organisation_id`,`domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `organisation_domains_verified_domain_unique` ON `organisation_domains` (`domain`) WHERE "organisation_domains"."verified_at" is not null;--> statement-breakpoint
ALTER TABLE `organisations` ADD `sign_in_policy` text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `sign_in_provider` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `sign_in_tenant` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `sign_in_method` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `sign_in_tenant` text;--> statement-breakpoint
ALTER TABLE `sign_ins` ADD `method` text;