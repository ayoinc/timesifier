import type { Config } from "@react-router/dev/config";

export default {
	// Config options...
	// Server-side render by default, to enable SPA mode set this to `false`
	ssr: true,
	// Every page arrives knowing every route, so a navigation never waits to
	// discover the one it is going to. While it waits, React Router 8.5.1 lets a
	// revalidation that a fetcher's action started earlier end that navigation
	// with the old page's routes and data: the address changes and the page does
	// not (a press on Reports straight after a new organisation's Timesheet
	// arrives, while the timer saves the time zone). docs/design-system.md,
	// "How a change of destination moves", says more.
	routeDiscovery: { mode: "initial" },
} satisfies Config;
