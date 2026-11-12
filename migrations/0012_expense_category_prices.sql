CREATE TABLE `expense_category_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`category_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organisation_id`,`category_id`) REFERENCES `expense_categories`(`organisation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "expense_category_prices_not_negative" CHECK("expense_category_prices"."unit_price_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_category_prices_organisation_id_id_unique` ON `expense_category_prices` (`organisation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `expense_category_prices_category_id_effective_from_unique` ON `expense_category_prices` (`organisation_id`,`category_id`,`effective_from`);