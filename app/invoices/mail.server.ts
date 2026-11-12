import { env } from "cloudflare:workers";
import { and, asc, eq } from "drizzle-orm";

import { recordStatement } from "~/activity/activity.server";
import { sendEmail } from "~/auth/email.server";
import { compose } from "~/auth/email-frame";
import { takeOne } from "~/auth/quota.server";
import type { OrganisationScope } from "~/db";

import { formatDayWithYear } from "~/time/format";

import { type PrintedDocument, pdfFilename, pdfOf } from "./pdf";

/**
 * A client's billing contacts, and the messages that carry an invoice or an
 * estimate to them (TS-074, TS-077). Every message goes through the one
 * email adapter (`sendEmail`) with the document's PDF, and every send is
 * recorded on the document's history. An organisation sends at most
 * `DOCUMENT_EMAILS` such messages a day, so a mistake or a stolen session
 * cannot turn the product into a mail cannon (docs/security.md).
 */

/** The most document messages one organisation sends in any 24 hours. */
export const DOCUMENT_EMAILS = { max: 200, seconds: 24 * 60 * 60 };

export const TOO_MANY_EMAILS =
	"This organisation has sent its 200 invoice and estimate emails for the last 24 hours. Try again later.";

/** One address, as a form carries it and as the email adapter accepts it. */
export const EMAIL_ADDRESS = /^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]+$/;

/** A client's billing contacts, oldest first. */
export function contactsOf(scope: OrganisationScope, clientId: string) {
	return scope.clientContacts.select((c) => eq(c.clientId, clientId), {
		orderBy: (c) => [asc(c.createdAt)],
	});
}

/** Adds a billing contact to a client; an address it already has is kept once. */
export async function addContact(
	scope: OrganisationScope,
	clientId: string,
	contact: { name: string | null; email: string },
): Promise<boolean> {
	const [client] = await scope.clients.select((c) => eq(c.id, clientId), { limit: 1 });
	if (!client) return false;
	const emailKey = contact.email.toLowerCase();
	const [held] = await scope.clientContacts.select(
		(c) => and(eq(c.clientId, clientId), eq(c.emailKey, emailKey)),
		{ limit: 1 },
	);
	if (held) return true;
	await scope.clientContacts.insert({
		clientId,
		name: contact.name,
		email: contact.email,
		emailKey,
	});
	return true;
}

/** Removes a billing contact. */
export async function removeContact(scope: OrganisationScope, contactId: string): Promise<boolean> {
	return (await scope.clientContacts.delete((c) => eq(c.id, contactId))).length > 0;
}

/** The words a document's message is written from, with the document's own values put in. */
export interface DocumentMessage {
	kind: "invoice" | "estimate" | "reminder";
	organisationName: string;
	clientName: string;
	number: string;
	/** The total, or for a reminder the balance due, formatted. */
	amount: string;
	/** An invoice's due date. */
	dueOn?: string;
	/** A note from the sender, quoted as they wrote it. */
	note?: string | null;
	/** An estimate's link, where the client accepts or declines it. */
	link?: string;
}

/** The template of each message's subject; `{name}` is a value of the document. */
export const SUBJECTS: Record<DocumentMessage["kind"], string> = {
	invoice: "Invoice {number} from {organisation}",
	estimate: "Estimate {number} from {organisation}",
	reminder: "Reminder: invoice {number} from {organisation} is overdue",
};

/** `template` with each `{name}` replaced by its value; a name with no value is left as it is. */
export function fillTemplate(template: string, values: Record<string, string | undefined>): string {
	return template.replace(/\{([a-z_]+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** The message for `words`, framed as every message of the application is. */
export function documentMessage(words: DocumentMessage) {
	const values = {
		organisation: words.organisationName,
		client: words.clientName,
		number: words.number,
		amount: words.amount,
		due_date: words.dueOn ? formatDayWithYear(words.dueOn) : undefined,
	};
	const subject = fillTemplate(SUBJECTS[words.kind], values);
	const note = words.note ? [words.note] : [];
	switch (words.kind) {
		case "invoice":
			return compose({
				subject,
				heading: fillTemplate("Invoice {number}", values),
				parts: [
					...note,
					fillTemplate(
						"{organisation} has sent you invoice {number} for {amount}, due on {due_date}. It is attached as a PDF.",
						values,
					),
				],
				reason: fillTemplate(
					"You are a billing contact of {client} at {organisation}. Reply to {organisation} if this is not for you.",
					values,
				),
			});
		case "reminder":
			return compose({
				subject,
				heading: fillTemplate("Invoice {number} is overdue", values),
				parts: [
					fillTemplate(
						"Invoice {number} from {organisation} was due on {due_date}, and {amount} is still owed. It is attached as a PDF.",
						values,
					),
				],
				reason: fillTemplate(
					"You are a billing contact of {client} at {organisation}. Reminders stop once the invoice is paid.",
					values,
				),
			});
		case "estimate":
			return compose({
				subject,
				heading: fillTemplate("Estimate {number}", values),
				parts: [
					...note,
					fillTemplate(
						"{organisation} has sent you estimate {number} for {amount}. It is attached as a PDF. Read it and accept or decline it at the link below; you do not need an account.",
						values,
					),
					{ action: "Read the estimate", link: words.link ?? "" },
				],
				reason: fillTemplate(
					"You are a billing contact of {client} at {organisation}. Anyone with the link can accept or decline the estimate, so do not forward it.",
					values,
				),
			});
	}
}

/**
 * Sends `printed` as a PDF to each of `to`, one message each, and records
 * the send on the document's history. Refused, before anything is sent,
 * when the organisation has reached its daily cap.
 */
export async function sendDocument(
	scope: OrganisationScope,
	actor: string | null,
	subject: { type: "invoice" | "estimate"; id: string },
	to: readonly string[],
	words: DocumentMessage,
	printed: PrintedDocument,
	source: "web" | "system" = "web",
): Promise<{ ok: true } | { ok: false; problem: string }> {
	for (const _ of to) {
		if (!(await takeOne(env.DB, `document-emails:${scope.organisationId}`, DOCUMENT_EMAILS))) {
			return { ok: false, problem: TOO_MANY_EMAILS };
		}
	}
	const message = documentMessage(words);
	const pdf = pdfOf(printed);
	const filename = pdfFilename(printed.title, printed.number);
	await Promise.all(
		to.map((address) =>
			sendEmail({
				to: address,
				...message,
				attachments: [
					{ disposition: "attachment", filename, type: "application/pdf", content: pdf },
				],
			}),
		),
	);
	await scope.batch([
		recordStatement(
			scope,
			actor,
			subject.type === "invoice" ? "invoice.sent" : "estimate.sent",
			subject,
			{ after: { recipients: to.length, reminder: words.kind === "reminder" } },
			source,
		),
	]);
	return { ok: true };
}
