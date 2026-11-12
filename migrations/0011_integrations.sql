CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`webhook_id` text NOT NULL,
	`event` text NOT NULL,
	`activity_id` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_status` integer,
	`last_error` text,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`webhook_id`) REFERENCES `webhooks`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "webhook_deliveries_status_known" CHECK("webhook_deliveries"."status" IN ('pending', 'delivered', 'failed')),
	CONSTRAINT "webhook_deliveries_attempts_not_negative" CHECK("webhook_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_organisation_id_id_unique` ON `webhook_deliveries` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_webhook_id_activity_id_unique` ON `webhook_deliveries` (`webhook_id`,`activity_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_status_next_attempt_at_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_organisation_id_webhook_id_created_at_idx` ON `webhook_deliveries` (`organisation_id`,`webhook_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `calendar_feeds` ADD `include_entries` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `import_jobs` ADD `source` text;--> statement-breakpoint
ALTER TABLE `import_jobs` ADD `mapping` text;--> statement-breakpoint
ALTER TABLE `import_jobs` ADD `skipped` text;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `include_descriptions` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `cursor` text;