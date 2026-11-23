import { SECURITY_EMAIL, SECURITY_PATH } from "~/landing/Site";

import type { Route } from "./+types/security-txt";

// /.well-known/security.txt, RFC 9116: where to report a vulnerability, for
// the host it was asked on. https://www.rfc-editor.org/rfc/rfc9116
// It is not a page, so it is not in the sitemap. It is not signed yet: a
// signature is recommended, not required (research/corporate/cards.md, "Later").

/**
 * When the file stops being valid. RFC 9116 asks for "less than a year into
 * the future" (2.5.5); this is a year less a day after 23 November 2026, when
 * it was set. test/trust.test.ts fails from 30 days before it, so that it is
 * renewed, with a new date and this comment, before it lapses.
 */
export const SECURITY_TXT_EXPIRES = "2027-11-22T00:00:00.000Z";

/** When the date above was set: a renewal moves both. */
export const SECURITY_TXT_SET = "2026-11-23T00:00:00.000Z";

export function loader({ request }: Route.LoaderArgs) {
	const origin = new URL(request.url).origin;
	const lines = [
		`Contact: mailto:${SECURITY_EMAIL}`,
		`Expires: ${SECURITY_TXT_EXPIRES}`,
		`Canonical: ${origin}/.well-known/security.txt`,
		`Policy: ${origin}${SECURITY_PATH}#reporting`,
		"Preferred-Languages: en",
	];
	return new Response(`${lines.join("\n")}\n`, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}
