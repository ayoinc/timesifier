import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_IDS } from "~/auth/email-frame";
import { MADE_WITH } from "~/brand/made-with";
import { type OrganisationScope, organisationScope } from "~/db";
import { sendInvoice } from "~/invoices/deliver.server";
import { createDraft } from "~/invoices/invoices.server";
import type { DraftLine } from "~/invoices/lines";
import { addContact } from "~/invoices/mail.server";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, invite, value } from "../organisations/harness";
import { open, type Person, person } from "../pages/harness";
import { png, submitFiles, svg } from "./files";

// What an organisation sends its clients carries its brand first (TS-100): the
// PDF of an invoice leads with its logo on a band of its colour, names it as
// the author, and says "Made with Timesifier" at the foot of every page; the
// message that carries the PDF shows its logo, attached to the message. And no
// message the application sends has an image that is fetched from anywhere.

const TODAY = "2026-11-02";

let mailbox: Mailbox;
let scope: OrganisationScope;
let ada: Person;
let acme: { id: string };
let clientId: string;
let SETTINGS: string;
let INVOICES: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme & Co");
	scope = organisationScope(env.DB, acme.id);
	const slug = await value<string>("select slug from organisations where id = ?", acme.id);
	SETTINGS = `/app/${slug}/settings`;
	INVOICES = `/app/${slug}/invoices`;
	const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	if (!client) throw new Error("seed failed");
	clientId = client.id;
	await addContact(scope, ada.user.id, clientId, { name: "Bola", email: "bola@initech.example" });
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const manual = (description: string): DraftLine => ({
	kind: "manual",
	description,
	projectId: null,
	quantityMilli: 1000,
	unitPriceMinor: 10_000,
	amountMinor: 10_000,
	timeEntryIds: [],
	expenseIds: [],
});

async function invoice(lines = 1) {
	const made = await createDraft(scope, ada.user.id, {
		clientId,
		currency: "GBP",
		issuedOn: TODAY,
		lines: Array.from({ length: lines }, (_, at) => manual(`Work ${at + 1}`)),
	});
	if (!made.ok) throw new Error(made.problem);
	return made.id;
}

async function brand({ logo, colour }: { logo?: Uint8Array<ArrayBuffer>; colour?: string }) {
	if (logo) {
		const saved = await submitFiles(
			SETTINGS,
			{ intent: "brand-logo", logo: { bytes: logo, name: "logo.png", type: "image/png" } },
			ada,
		);
		expect(saved.status).toBe(200);
	}
	if (colour) {
		expect((await submitFiles(SETTINGS, { intent: "brand-colour", colour }, ada)).status).toBe(200);
	}
}

async function pdfOfInvoice(id: string): Promise<string> {
	const served = await open(`${INVOICES}/${id}/pdf`, ada);
	expect(served.status).toBe(200);
	expect(served.headers.get("Content-Type")).toBe("application/pdf");
	return new TextDecoder("latin1").decode(await served.arrayBuffer());
}

/** Each page's drawing: the content streams, in order. */
function pagesOf(pdf: string): string[] {
	return [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)]
		.map(([, body = ""]) => body)
		.filter((body) => body.includes(" Tj"));
}

const count = (text: string, part: string) => text.split(part).length - 1;

describe("an invoice's PDF", () => {
	it("leads with the organisation's logo on its colour, names it as author, and is made with Timesifier on every page", async () => {
		await brand({ logo: await png(120, 40), colour: "#1d4ed8" });
		const pdf = await pdfOfInvoice(await invoice(60));

		expect(pdf).toContain("/Author (Acme & Co)");
		expect(pdf).toContain("/Producer (Timesifier)");
		// Two images: the logo, 120 by 40, and the product's mark.
		expect(pdf).toMatch(/\/Logo \d+ 0 R/);
		expect(pdf).toMatch(/\/Mark \d+ 0 R/);
		expect(pdf).toMatch(/\/Subtype \/Image \/Width 120 \/Height 40/);

		const pages = pagesOf(pdf);
		expect(pages.length).toBeGreaterThan(1);
		// The band in #1d4ed8 (29, 78, 216) on every page; the logo leads the first.
		const band = `${(29 / 255).toFixed(3)} ${(78 / 255).toFixed(3)} ${(216 / 255).toFixed(3)} rg`;
		for (const page of pages) {
			expect(page).toContain(band);
			expect(count(page, "/Mark Do")).toBe(1);
			expect(count(page, `(${MADE_WITH}) Tj`)).toBe(1);
		}
		expect(count(pages[0] ?? "", "/Logo Do")).toBe(1);
	});

	it("without a logo or colour, still names the organisation and is made with Timesifier", async () => {
		const pdf = await pdfOfInvoice(await invoice());
		expect(pdf).toContain("/Author (Acme & Co)");
		expect(pdf).not.toMatch(/\/Logo /);
		expect(pdf).toContain(`(${MADE_WITH}) Tj`);
		expect(pdf).toContain("/Mark Do");
	});
});

describe("the message that carries a document", () => {
	async function send() {
		const id = await invoice();
		const before = mailbox.sent().length;
		expect(
			await sendInvoice(scope, ada.user.id, id, {
				organisationName: "Acme & Co",
				to: ["bola@initech.example"],
				locale: "en-GB",
				today: TODAY,
				now: new Date(`${TODAY}T12:00:00Z`),
			}),
		).toEqual({ ok: true, number: "1" });
		const [message] = mailbox.sent().slice(before);
		if (!message) throw new Error("nothing sent");
		return message;
	}

	it("shows the organisation's logo, attached inline, and the mark beside Made with Timesifier", async () => {
		const logo = await png(120, 40);
		await brand({ logo, colour: "#1d4ed8" });
		const message = await send();

		expect(message.html).toContain(
			`src="cid:${CONTENT_IDS.organisationLogo}" width="120" height="40" alt="Acme &amp; Co"`,
		);
		expect(message.html).toContain("#1d4ed8");
		const inline = message.attachments.filter((file) => file.disposition === "inline");
		expect(inline.map(({ contentId, type }) => ({ contentId, type }))).toEqual([
			{ contentId: CONTENT_IDS.organisationLogo, type: "image/png" },
			{ contentId: CONTENT_IDS.mark, type: "image/png" },
		]);
		expect(inline[0]?.content).toEqual(logo);
		expect(message.text).toContain(MADE_WITH);
	});

	it("shows the PNG drawn from an SVG logo, never the SVG", async () => {
		const drawn = await png(90, 30);
		const saved = await submitFiles(
			SETTINGS,
			{
				intent: "brand-logo",
				logo: { bytes: svg(), name: "logo.svg", type: "image/svg+xml" },
				rendition: { bytes: drawn, name: "logo.png", type: "image/png" },
			},
			ada,
		);
		expect(saved.status).toBe(200);
		const message = await send();
		const logo = message.attachments.find(
			(file) => file.contentId === CONTENT_IDS.organisationLogo,
		);
		expect(logo?.type).toBe("image/png");
		expect(logo?.content).toEqual(drawn);
		expect(message.attachments.some((file) => file.type === "image/svg+xml")).toBe(false);
	});

	it("without a logo, leads with the organisation's name and attaches only the mark", async () => {
		const message = await send();
		expect(message.html).not.toContain(`cid:${CONTENT_IDS.organisationLogo}`);
		expect(
			message.attachments.filter((file) => file.disposition === "inline").map((f) => f.contentId),
		).toEqual([CONTENT_IDS.mark]);
	});
});

describe("every message the application sends", () => {
	it("has no image fetched from anywhere: each source is one of its own attached parts", async () => {
		await brand({ logo: await png(120, 40) });
		// A sign-in code (sent already), an invitation, and an invoice.
		await invite(ada.cookie, acme.id, "grace@example.com");
		const id = await invoice();
		await sendInvoice(scope, ada.user.id, id, {
			organisationName: "Acme & Co",
			to: ["bola@initech.example"],
			locale: "en-GB",
			today: TODAY,
			now: new Date(`${TODAY}T12:00:00Z`),
		});

		const sent = mailbox.sent();
		expect(new Set(sent.map((message) => message.subject)).size).toBeGreaterThanOrEqual(3);
		for (const message of sent) {
			const sources = [...message.html.matchAll(/\s(?:src|background|srcset)="([^"]*)"/gi)].map(
				([, src = ""]) => src,
			);
			expect(sources.length, message.subject).toBeGreaterThan(0);
			const attached = new Set(message.attachments.map((file) => `cid:${file.contentId}`));
			for (const src of sources) {
				expect(src, message.subject).not.toMatch(/^(?:https?:|\/\/|data:)/i);
				expect(attached.has(src), `${message.subject}: ${src}`).toBe(true);
			}
			expect(message.html, message.subject).not.toMatch(/url\(/i);
		}
	});
});
