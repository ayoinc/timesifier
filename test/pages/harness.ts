import { exports } from "cloudflare:workers";
import { type Mailbox, ORIGIN, signIn } from "../auth/harness";

// The pages, asked for the way a browser asks: the document, the data request
// a move between pages makes, and a form posted from our own page. Everything
// goes through the Worker's real fetch handler.

/** A signed-in person: their session, and the client address their requests come from. */
export type Person = { cookie: string; client: string; user: { id: string; email: string } };

let clients = 0;

/**
 * Signs a person in from a client address of their own, from the block
 * reserved for documentation (RFC 5737). The limits on asking for a code count
 * by client, and a test that needs four people is not one client.
 */
export async function person(mailbox: Mailbox, email: string): Promise<Person> {
	clients = (clients % 250) + 1;
	const client = `198.51.100.${clients}`;
	const { cookie, user } = await signIn(mailbox, email, { client });
	return { cookie, client, user };
}

function headersOf(who: Person | undefined, more: Record<string, string> = {}): Headers {
	const headers = new Headers(more);
	if (who) {
		headers.set("Cookie", who.cookie);
		headers.set("CF-Connecting-IP", who.client);
	}
	return headers;
}

/** The page at `path` as a browser loads it. Redirects are returned, not followed. */
export function open(path: string, who?: Person): Promise<Response> {
	return exports.default.fetch(
		new Request(`${ORIGIN}${path}`, { headers: headersOf(who), redirect: "manual" }),
	);
}

/** The address React Router asks for the data of the page at `path`. */
export function dataAddress(path: string): string {
	const [pathname = "", query] = path.split("?");
	return `${pathname}.data${query === undefined ? "" : `?${query}`}`;
}

/** The data of the page at `path`, as a move to it asks for it. */
export function openData(path: string, who?: Person): Promise<Response> {
	return open(dataAddress(path), who);
}

/**
 * A form posted to `path` from our own page: by the browser itself, or by
 * script to the page's data address when `byScript` is set.
 */
export function submit(
	path: string,
	fields: Record<string, string>,
	who?: Person,
	{ byScript = false } = {},
): Promise<Response> {
	return exports.default.fetch(
		new Request(`${ORIGIN}${byScript ? dataAddress(path) : path}`, {
			method: "POST",
			headers: headersOf(who, {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: ORIGIN,
			}),
			body: new URLSearchParams(fields).toString(),
			redirect: "manual",
		}),
	);
}

/**
 * A page's HTML without what differs between any two responses: the nonce the
 * Content Security Policy gives each one. Two pages that are the same to a
 * person are then the same string.
 */
export async function pageBody(response: Response): Promise<string> {
	return (await response.text()).replace(/nonce="[^"]*"/g, 'nonce=""');
}

/** The text a person would read on a page: its HTML without tags, scripts and styles. */
export function textOf(html: string): string {
	return html
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, " ")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}
