import { env } from "cloudflare:workers";

import { sendEmail } from "~/auth/email.server";
import { isOurHost } from "~/auth/hosts";
import { isKeyedHash, keyedHash } from "~/auth/keyed-hash.server";
import { getPlatformBrand } from "~/brand/platform-brand.server";
import { platformData } from "~/db";
import { required, setting } from "~/lib/deployment";

import { type MailKind, mailingEmail } from "./emails";
import { DAILY_MAIL_CAP, MAIL_BATCH } from "./limits";

// Mail to account holders (TS-099). A platform owner writes a mailing; one
// waiting delivery is made for each person it goes to; the scheduled work
// sends them a few each minute, never more in a day than `DAILY_MAIL_CAP`,
// and skips a person who has turned that kind of mail off or whose account
// was closed since. Every message carries a signed link that turns its kind
// off in one press, with the headers that let a mail program do the same
// (RFC 8058); the link needs no session.

const PURPOSE = "unsubscribe";

/** The word for each kind in an unsubscribe link. */
const LINK_WORDS: Record<MailKind, string> = {
	announcement: "announcements",
	newsletter: "newsletter",
};

export function kindOfLinkWord(word: string): MailKind | null {
	const found = Object.entries(LINK_WORDS).find(([, value]) => value === word);
	return found ? (found[0] as MailKind) : null;
}

function signatureOf(kind: MailKind, userId: string): Promise<string> {
	return keyedHash(required(env, "BETTER_AUTH_SECRET"), PURPOSE, `${kind}\n${userId}`);
}

/** The path of the link that stops `kind` for one person. */
export async function unsubscribePath(kind: MailKind, userId: string): Promise<string> {
	return `/unsubscribe/${LINK_WORDS[kind]}/${encodeURIComponent(userId)}/${await signatureOf(kind, userId)}`;
}

/** Whether the link's signature is the one this deployment made for that person and kind. */
export function isUnsubscribeSignature(kind: MailKind, userId: string, signature: string) {
	return isKeyedHash(required(env, "BETTER_AUTH_SECRET"), PURPOSE, `${kind}\n${userId}`, signature);
}

/** The origin a message's links point to: production's host, or the request's own where it is ours. */
export function mailOrigin(request?: Request): string {
	if (request && isOurHost(request, env)) return new URL(request.url).origin;
	const host = setting(env, "APP_HOST");
	return host ? `https://${host}` : "http://localhost";
}

/** The start of the UTC day `now` falls in. */
function dayStart(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** How many more messages may go today. */
export async function capLeft(now: Date): Promise<number> {
	return Math.max(0, DAILY_MAIL_CAP - (await platformData.sentSince(env.DB, dayStart(now))));
}

/**
 * Sends the next waiting deliveries, within the batch and the day's cap.
 * Answers how many were sent. A message Email Service did not take stays
 * waiting, and the run stops there, to try again next minute.
 */
export async function sendWaitingMail(now: Date): Promise<number> {
	const left = Math.min(MAIL_BATCH, await capLeft(now));
	if (left === 0) return 0;
	const waiting = await platformData.waitingDeliveries(env.DB, left);
	const origin = mailOrigin();
	const platform = await getPlatformBrand(env);
	let sent = 0;
	for (const delivery of waiting) {
		const kind: MailKind = delivery.kind === "newsletter" ? "newsletter" : "announcement";
		const wanted =
			!delivery.closedAt && (kind === "newsletter" ? delivery.newsletter : delivery.announcements);
		if (!wanted) {
			await platformData.markDelivery(env.DB, delivery, "skipped", now);
			continue;
		}
		const message = mailingEmail(
			{
				kind,
				subject: delivery.subject,
				body: delivery.body,
				unsubscribe: `${origin}${await unsubscribePath(kind, delivery.userId)}`,
			},
			platform,
		);
		if (!(await sendEmail({ to: delivery.email, ...message }))) break;
		await platformData.markDelivery(env.DB, delivery, "sent", now);
		sent += 1;
	}
	return sent;
}
