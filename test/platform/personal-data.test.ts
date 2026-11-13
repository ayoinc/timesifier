import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { crc32 } from "~/lib/zip";
import { personalDataResponse } from "~/platform/personal-data.server";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { seedMember, seedMembership, seedOrganisation } from "../organisations/harness";
import { person } from "../pages/harness";

// A person's data (TS-099, data requests): one ZIP of their account, their
// sign-ins, and in each of their organisations their own entries, expenses and
// leave. Nothing of anybody else's: not another member's description, not
// another person's address.

const NOW = new Date("2026-11-12T12:00:00Z");
const HOUR = 3_600_000;

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** The files of a ZIP by name, read through its central directory, each CRC checked. */
async function unzip(file: Uint8Array<ArrayBuffer>): Promise<Map<string, string>> {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const end = file.length - 22;
	expect(view.getUint32(end, true)).toBe(0x0605_4b50);
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	const decoder = new TextDecoder();
	const files = new Map<string, string>();
	for (let n = 0; n < count; n++) {
		const method = view.getUint16(at + 10, true);
		const crc = view.getUint32(at + 16, true);
		const compressed = view.getUint32(at + 20, true);
		const nameLength = view.getUint16(at + 28, true);
		const local = view.getUint32(at + 42, true);
		const name = decoder.decode(file.subarray(at + 46, at + 46 + nameLength));
		at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const data = file.slice(start, start + compressed);
		const bytes =
			method === 8
				? new Uint8Array(
						await new Response(
							new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
						).arrayBuffer(),
					)
				: data;
		expect(crc32(bytes)).toBe(crc);
		files.set(name, decoder.decode(bytes));
	}
	return files;
}

/** One organisation's records of one person: an entry, an expense and leave, each named with `mark`. */
async function records(organisationId: string, userId: string, mark: string, day: string) {
	const scope = organisationScope(env.DB, organisationId);
	let [project] = await scope.projects.select();
	if (!project) [project] = await scope.projects.insert({ name: "Site", nameKey: "site" });
	let [category] = await scope.expenseCategories.select();
	if (!category)
		[category] = await scope.expenseCategories.insert({ name: "Travel", nameKey: "travel" });
	const [annual] = await scope.leaveKinds.select();
	if (!project || !category || !annual) throw new Error("seed failed");
	const startedAt = new Date(`${day}T09:00:00Z`);
	await scope.timeEntries.insert({
		userId,
		projectId: project.id,
		description: `${mark} entry`,
		startedAt,
		endedAt: new Date(startedAt.getTime() + HOUR),
	});
	await scope.expenses.insert({
		userId,
		projectId: project.id,
		categoryId: category.id,
		spentOn: day,
		amountMinor: 1250,
		currency: "GBP",
		notes: `${mark} expense`,
	});
	await scope.leaveRequests.insert({
		userId,
		kindId: annual.id,
		startsOn: day,
		endsOn: day,
		status: "approved",
		note: `${mark} leave`,
	});
}

describe("a person's data", () => {
	it("holds their own records from every organisation, and nobody else's", async () => {
		const ada = await person(mailbox, "ada@example.com");
		const acme = await seedOrganisation("Acme", "acme");
		const globex = await seedOrganisation("Globex", "globex");
		await seedMembership(acme.id, ada.user.id, "owner");
		await seedMembership(globex.id, ada.user.id, "member");
		const bola = await seedMember(acme.id, "member", "bola@example.com");
		await seedMembership(globex.id, bola.userId, "owner");
		await records(acme.id, ada.user.id, "Ada at Acme", "2026-11-02");
		await records(globex.id, ada.user.id, "Ada at Globex", "2026-11-03");
		await records(acme.id, bola.userId, "Bola at Acme", "2026-11-04");
		await records(globex.id, bola.userId, "Bola at Globex", "2026-11-05");

		const response = personalDataResponse(ada.user.id, NOW);

		expect(response.headers.get("Content-Type")).toBe("application/zip");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const files = await unzip(new Uint8Array(await response.arrayBuffer()));
		expect([...files.keys()]).toEqual([
			"account.json",
			"sign-ins.csv",
			"time-entries.csv",
			"expenses.csv",
			"leave.csv",
		]);

		const account = JSON.parse(files.get("account.json") ?? "");
		expect(account).toMatchObject({ id: ada.user.id, email: "ada@example.com" });
		expect(account.organisations).toEqual([
			{ name: "Acme", slug: "acme", role: "owner" },
			{ name: "Globex", slug: "globex", role: "member" },
		]);
		expect(files.get("sign-ins.csv")?.split("\r\n").filter(Boolean).length).toBeGreaterThan(1);
		for (const [file, kind] of [
			["time-entries.csv", "entry"],
			["expenses.csv", "expense"],
			["leave.csv", "leave"],
		] as const) {
			const text = files.get(file) ?? "";
			expect(text).toContain(`Ada at Acme ${kind}`);
			expect(text).toContain(`Ada at Globex ${kind}`);
			expect(text).not.toContain("Bola");
		}
		const everything = [...files.values()].join("\n");
		expect(everything).not.toContain("Bola");
		expect(everything).not.toContain("bola@example.com");
		// The only address in it is the person's own.
		expect([...everything.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)].map(([found]) => found)).toEqual(
			["ada@example.com"],
		);
	});

	it("is an empty ZIP for an account that is not there", async () => {
		const files = await unzip(
			new Uint8Array(await personalDataResponse("no-such-account", NOW).arrayBuffer()),
		);
		expect(files.size).toBe(0);
	});
});
