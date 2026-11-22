import { PUBLIC_PAGES } from "~/landing/Site";

import type { Route } from "./+types/sitemap";

// The sitemap: every public page and nothing else, each at its canonical
// address on the origin it was asked for. It gives no dates: a page's words
// change without a date anyone records, and a wrong date is worse than none.

export function loader({ request }: Route.LoaderArgs) {
	const origin = new URL(request.url).origin;
	const urls = PUBLIC_PAGES.map((path) => `<url><loc>${origin}${path}</loc></url>`).join("");
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`,
		{ headers: { "Content-Type": "application/xml; charset=utf-8" } },
	);
}
