CREATE TABLE `client_managers` (
	`organisation_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `user_id`),
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`client_id`) REFERENCES `clients`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`user_id`) REFERENCES `memberships`(`organisation_id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `client_managers_organisation_id_user_id_idx` ON `client_managers` (`organisation_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `clients` ADD `code` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `code_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `clients_organisation_id_code_key_unique` ON `clients` (`organisation_id`,`code_key`);--> statement-breakpoint
ALTER TABLE `organisations` ADD `work_model` text DEFAULT 'client_projects' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `internal_term` text DEFAULT 'Work codes' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `project_code_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `work_code_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `project_code_pattern` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `project_code_next` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `code` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `code_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_organisation_id_code_key_unique` ON `projects` (`organisation_id`,`code_key`);--> statement-breakpoint
-- Existing organisations keep what they see (TS-115a, decision 67): Both where
-- Clients was on, and Internal work where it was off, still saying "Projects".
UPDATE `organisations` SET
	`work_model` = CASE WHEN `clients_enabled` = 1 THEN 'both' ELSE 'internal' END,
	`internal_term` = CASE WHEN `clients_enabled` = 1 THEN `internal_term` ELSE 'Projects' END;
