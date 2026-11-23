import * as z from "zod";

import { isKeyedHash, keyedHash } from "~/auth/keyed-hash.server";
import type { DeletedEntry } from "~/time/manual.server";

/**
 * "Entry deleted." with Undo (taste HT-A): an entry is deleted at once, and the
 * answer carries a token that puts it back. The token is what the entry was,
 * for whom and in which organisation, and when it was deleted, signed with the
 * application's secret (`keyedHash`), so the page can hand it back but cannot
 * write one of its own: Undo restores exactly the entry the person deleted, in
 * the same organisation, within `UNDO_WINDOW_MS`. Nothing waits on the server:
 * a person who leaves the page has deleted the entry, as they asked.
 */

/** The snackbar offers Undo for 8 seconds; the server takes it a little longer, for a slow answer. */
export const UNDO_SHOWN_MS = 8_000;
export const UNDO_WINDOW_MS = 60_000;

const PURPOSE = "time-entry-undo";

const Payload = z.object({
	organisationId: z.string(),
	userId: z.string(),
	deletedAt: z.number(),
	entry: z.object({
		id: z.string(),
		projectId: z.string(),
		taskId: z.string().nullable(),
		billable: z.boolean(),
		description: z.string().nullable(),
		startedAt: z.number(),
		endedAt: z.number(),
		tagIds: z.array(z.string()),
		overtime: z.boolean(),
		spentOn: z.iso.date(),
	}),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(text: string): string {
	let binary = "";
	for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | null {
	try {
		const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
		return decoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
	} catch {
		return null;
	}
}

/** The token that puts `entry` back, for `userId` in `organisationId`. */
export async function undoToken(
	secret: string,
	who: { organisationId: string; userId: string },
	entry: DeletedEntry,
	now: number,
): Promise<string> {
	const body = toBase64Url(JSON.stringify({ ...who, deletedAt: now, entry }));
	return `${body}.${await keyedHash(secret, PURPOSE, body)}`;
}

/**
 * The entry a token puts back, when it was signed here for this person in this
 * organisation and is still in its window; else null.
 */
export async function entryOfUndo(
	secret: string,
	token: string,
	who: { organisationId: string; userId: string },
	now: number,
): Promise<DeletedEntry | null> {
	const [body, hash, ...rest] = token.split(".");
	if (!body || !hash || rest.length > 0) return null;
	if (!(await isKeyedHash(secret, PURPOSE, body, hash))) return null;
	const json = fromBase64Url(body);
	if (json === null) return null;
	let parsed: z.infer<typeof Payload>;
	try {
		parsed = Payload.parse(JSON.parse(json));
	} catch {
		return null;
	}
	if (parsed.organisationId !== who.organisationId || parsed.userId !== who.userId) return null;
	if (now < parsed.deletedAt || now - parsed.deletedAt > UNDO_WINDOW_MS) return null;
	return parsed.entry;
}
