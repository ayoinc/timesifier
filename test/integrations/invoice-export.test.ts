import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { createDraft, issueInvoice, voidInvoice } from "~/invoices/invoices.server";
import { crc32 } from "~/lib/zip";
import { dayOf } from "~/time/calendar";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam } from "../organisations/harness";
import { open, type Person, person } from "../pages/harness";

// Every invoice as its PDF in one ZIP (TS-076), below Integrations: owners and
// admins download it, everyone else gets the 404 a stranger gets. The ZIP is
// read back here, entry by entry, with its CRCs checked, and each PDF is the
// one the invoice's own page downloads.

const EXPORT = "/app/acme/integrations/invoices-export";

let mailbox: Mailbox;
let owner: Person;
let scope: OrganisationScope;
let clientId: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	owner = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(owner.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	if (!client) throw new Error("seed failed");
	clientId = client.id;
}, 30_000);

async function draft(amountMinor: number) {
	const made = await createDraft(scope, owner.user.id, {
		clientId,
		currency: "GBP",
		issuedOn: "2026-11-02",
		lines: [
			{
				kind: "manual",
				description: "Workshop",
				projectId: null,
				quantityMilli: 1000,
				unitPriceMinor: amountMinor,
				amountMinor,
				timeEntryIds: [],
				expenseIds: [],
			},
		],
	});
	if (!made.ok) throw new Error(made.problem);
	return made.id;
}

interface Unzipped {
	name: string;
	utf8: boolean;
	method: number;
	bytes: Uint8Array;
}

async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The end record, found as an unzipper finds it: searching back from the end
 * for its signature, at the place where the comment it gives the length of
 * ends the file. With the archive's comment.
 */
function endRecord(file: Uint8Array<ArrayBuffer>): { end: number; comment: string } {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	for (let end = file.length - 22; end >= 0; end--) {
		if (view.getUint32(end, true) !== 0x0605_4b50) continue;
		const length = view.getUint16(end + 20, true);
		if (end + 22 + length !== file.length) continue;
		return { end, comment: new TextDecoder().decode(file.subarray(end + 22)) };
	}
	throw new Error("no end record");
}

/**
 * Reads a ZIP the way an unzipper does: the end record, then each entry of the
 * central directory, then its local header and data. Checks that the two
 * headers agree, that the sizes are right and that each CRC is the CRC of the
 * bytes it holds.
 */
async function unzip(file: Uint8Array<ArrayBuffer>): Promise<Unzipped[]> {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const { end } = endRecord(file);
	const count = view.getUint16(end + 10, true);
	const size = view.getUint32(end + 12, true);
	let at = view.getUint32(end + 16, true);
	expect(at + size).toBe(end);
	const decoder = new TextDecoder();
	const entries: Unzipped[] = [];
	for (let n = 0; n < count; n++) {
		expect(view.getUint32(at, true)).toBe(0x0201_4b50);
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		const crc = view.getUint32(at + 16, true);
		const compressed = view.getUint32(at + 20, true);
		const length = view.getUint32(at + 24, true);
		const nameLength = view.getUint16(at + 28, true);
		const extra = view.getUint16(at + 30, true);
		const comment = view.getUint16(at + 32, true);
		const local = view.getUint32(at + 42, true);
		const name = decoder.decode(file.subarray(at + 46, at + 46 + nameLength));
		at += 46 + nameLength + extra + comment;

		expect(view.getUint32(local, true)).toBe(0x0403_4b50);
		expect(view.getUint16(local + 6, true)).toBe(flags);
		expect(view.getUint16(local + 8, true)).toBe(method);
		expect(view.getUint32(local + 14, true)).toBe(crc);
		expect(view.getUint32(local + 18, true)).toBe(compressed);
		expect(view.getUint32(local + 22, true)).toBe(length);
		const localName = view.getUint16(local + 26, true);
		const start = local + 30 + localName + view.getUint16(local + 28, true);
		const data = file.slice(start, start + compressed);
		const bytes = method === 8 ? await inflateRaw(data) : data;
		expect(method === 0 || method === 8).toBe(true);
		expect(bytes.length).toBe(length);
		expect(crc32(bytes)).toBe(crc);
		entries.push({ name, utf8: (flags & 0x0800) !== 0, method, bytes });
	}
	return entries;
}

async function bytesOf(response: Response) {
	return new Uint8Array(await response.arrayBuffer());
}

describe("the CRC", () => {
	it("is CRC-32 as ZIP reads it", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf4_3926);
		expect(crc32(new Uint8Array())).toBe(0);
	});
});

describe("exporting every invoice as a PDF", () => {
	it("gives an owner a ZIP of every invoice's own PDF, drafts and void ones too, named by number", async () => {
		const drafted = await draft(5000);
		const issued = await draft(12_345);
		await issueInvoice(scope, owner.user.id, issued);
		const voided = await draft(700);
		await issueInvoice(scope, owner.user.id, voided);
		expect((await voidInvoice(scope, owner.user.id, voided, new Date()))?.ok).toBe(true);

		const response = await open(EXPORT, owner);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/zip");
		// Named for the organisation and the day it was exported, which the archive's comment says too (TS-100).
		const zone = await env.DB.prepare("select time_zone from organisations").first<string>(
			"time_zone",
		);
		const today = dayOf(Date.now(), zone ?? "UTC");
		expect(response.headers.get("Content-Disposition")).toBe(
			`attachment; filename="acme-all-invoices-exported-${today}.zip"`,
		);
		const file = await bytesOf(response);
		expect(new TextDecoder().decode(file.subarray(0, 2))).toBe("PK");
		expect(endRecord(file).comment).toBe(
			`Acme: all invoices, exported ${today}. Made with Timesifier.`,
		);
		const entries = await unzip(file);

		// Oldest first, as the ids sort; each the invoice's own PDF, byte for byte.
		const numbers = await env.DB.prepare("select id, number from invoices order by id").all<{
			id: string;
			number: string;
		}>();
		expect(numbers.results.map((r) => r.id).sort()).toEqual([drafted, issued, voided].sort());
		expect(entries.map((e) => e.name)).toEqual(
			numbers.results.map((r) => `invoice-${r.number}.pdf`),
		);
		expect(entries.every((e) => e.utf8)).toBe(true);
		for (const [index, { id }] of numbers.results.entries()) {
			const own = await bytesOf(await open(`/app/acme/invoices/${id}/pdf`, owner));
			expect(new TextDecoder().decode(own.subarray(0, 5))).toBe("%PDF-");
			expect(entries[index]?.bytes).toEqual(own);
		}
	});

	it("names two invoices whose numbers read the same in a file name apart", async () => {
		const first = await draft(100);
		const second = await draft(200);
		await env.DB.prepare("update invoices set number = '2026/1' where id = ?").bind(first).run();
		await env.DB.prepare("update invoices set number = '2026-1' where id = ?").bind(second).run();
		const entries = await unzip(await bytesOf(await open(EXPORT, owner)));
		// Whichever comes first keeps the name; the other is numbered.
		expect(entries.map((e) => e.name).sort()).toEqual([
			"invoice-2026-1-2.pdf",
			"invoice-2026-1.pdf",
		]);
	});

	it("is an empty ZIP for an organisation with no invoices", async () => {
		const file = await bytesOf(await open(EXPORT, owner));
		// The end record alone, with the archive's comment.
		expect(endRecord(file)).toEqual({
			end: 0,
			comment: expect.stringMatching(/^Acme: all invoices, exported \d{4}-\d{2}-\d{2}\. /),
		});
		expect(await unzip(file)).toEqual([]);
	});

	it("is for owners and admins only: Finance, a manager, a member and another organisation get 404", async () => {
		await draft(5000);
		const acmeId = scope.organisationId;
		const admin = await person(mailbox, "grace@example.com");
		const finance = await person(mailbox, "katherine@example.com");
		const manager = await person(mailbox, "hedy@example.com");
		const member = await person(mailbox, "linus@example.com");
		const stranger = await person(mailbox, "barbara@example.com");
		await seedMembership(acmeId, admin.user.id, "admin");
		await seedMembership(acmeId, finance.user.id, "finance");
		await seedMembership(acmeId, manager.user.id, "member");
		await seedMembership(acmeId, member.user.id, "member");
		await seedTeam(acmeId, "Design", { members: [member.user.id], managers: [manager.user.id] });
		await createOrganisation(stranger.cookie, "Globex");

		const asAdmin = await open(EXPORT, admin);
		expect(asAdmin.status).toBe(200);
		expect((await unzip(await bytesOf(asAdmin))).map((e) => e.name)).toHaveLength(1);
		for (const who of [finance, manager, member, stranger]) {
			const response = await open(EXPORT, who);
			expect(response.status).toBe(404);
		}
		expect((await open(EXPORT)).status).not.toBe(200);
	});
});
