import { feedCalendar } from "~/integrations/feeds.server";

import type { Route } from "./+types/calendar.$token";

// A calendar feed (TS-089): an ICS file at a secret address, read by a
// calendar without a session. An address that is not a working feed's, revoked
// or never made, answers the same 404.

export async function loader({ params }: Route.LoaderArgs) {
	const token = params.token.endsWith(".ics") ? params.token.slice(0, -4) : params.token;
	const calendar = await feedCalendar(token, Date.now());
	if (calendar === null) {
		return new Response("Not found", {
			status: 404,
			headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
		});
	}
	return new Response(calendar, {
		headers: {
			"Content-Type": "text/calendar; charset=utf-8",
			"Content-Disposition": 'inline; filename="timesifier.ics"',
			"Cache-Control": "private, no-store",
			"X-Robots-Tag": "noindex",
		},
	});
}
