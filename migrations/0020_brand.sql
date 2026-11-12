-- The brand everywhere (TS-100).
--
-- The platform's brand is one row, `platform`, that starts at what every
-- message and export says today: the name every message is from, the home
-- page's headline as the tagline, the line at the foot of a message, and the
-- amber of the band. No Reply-To, and the built-in logo and marks (an image
-- column left null). `app/brand/platform-brand.server.ts` holds the same values
-- for a database where the row is missing, and a test holds the two equal.
--
-- Each organisation gains its logo's media type, whether a PNG drawn from it is
-- stored too, when it was uploaded, and its colour: none to start with. The
-- files themselves are in R2, in the `BRAND` bucket.
CREATE TABLE `platform_brand` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_name` text NOT NULL,
	`reply_to` text,
	`tagline` text NOT NULL,
	`email_footer` text NOT NULL,
	`colour` text NOT NULL,
	`logo` text,
	`mark_light` text,
	`mark_dark` text,
	`updated_at` integer,
	`updated_by` text
);
--> statement-breakpoint
INSERT INTO `platform_brand` (`id`, `sender_name`, `tagline`, `email_footer`, `colour`) VALUES ('platform', 'Timesifier', 'Track your hours. Trust the total.', 'Sent by Timesifier.', '#fead05');--> statement-breakpoint
ALTER TABLE `organisations` ADD `brand_logo_type` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `brand_logo_rendition` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `brand_logo_version` integer;--> statement-breakpoint
ALTER TABLE `organisations` ADD `brand_colour` text;
