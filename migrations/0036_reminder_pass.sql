CREATE TABLE `reminder_pass` (
	`name` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`last_organisation` text,
	`last_entry` text,
	`finished_at` integer,
	`lease_token` text,
	`leased_until` integer DEFAULT 0 NOT NULL
);
