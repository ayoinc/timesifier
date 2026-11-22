import type { Route } from "./+types/robots";

// The application's own robots.txt. Without it, the Worker answered 404 and
// Cloudflare served its Content Signals Policy in its place, which names no
// sitemap. Every page may be crawled: the signed-in pages ask for a session and
// send a crawler, which has none, to the sign-in page. Where the zone's Bot Preference Sync is
// turned on, Cloudflare puts its managed lines before these.

export function loader({ request }: Route.LoaderArgs) {
	const origin = new URL(request.url).origin;
	return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}
