import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_CODE_TAKEN } from "~/clients/clients.server";
import { organisationScope } from "~/db";
import { isCodeClash } from "~/lib/codes";
import { PROJECT_CODE_TAKEN } from "~/projects/projects.server";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, value } from "../organisations/harness";
import { type Person, person, submit } from "./harness";

// A client's code and a project's (TS-115a, decision 67) are each unique in
// their organisation however they are capitalised or written (NFKC), archived
// ones included; a thing's own code in other letters is no clash; another
// organisation may have the same; and the unique index refuses what two
// writes at once would both have passed.

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** The two kinds, each with its page, its id field and what a clash says. */
const KINDS = [
	{ kind: "client", table: "clients", idField: "clientId", taken: CLIENT_CODE_TAKEN },
	{ kind: "project", table: "projects", idField: "projectId", taken: PROJECT_CODE_TAKEN },
] as const;

describe.each(KINDS)("a $kind's code", ({ table, idField, taken }) => {
	const page = table;
	const path = (slug = "acme") => `/app/${slug}/${page}`;

	async function send(fields: Record<string, string>, who = ada, slug = "acme") {
		const response = await submit(path(slug), fields, who, { byScript: true });
		return { status: response.status, said: await response.text() };
	}

	const idOf = (name: string) =>
		value<string>(`select id from ${table} where name = ?`, name) as Promise<string>;
	const count = () => value(`select count(*) from ${table}`);

	it("is refused in other capitals, and in another way of writing the same letters", async () => {
		expect((await send({ intent: "create", name: "First", code: "ACME-001" })).status).toBe(200);
		for (const code of ["acme-001", "Acme-001", " ACME-001 ", "ＡＣＭＥ-００１"]) {
			const answer = await send({ intent: "create", name: `Again ${code.trim()}`, code });
			expect(answer.status, code).toBe(400);
			expect(answer.said).toContain(taken);
		}
		expect(await count()).toBe(1);
		expect(await value(`select code_key from ${table}`)).toBe("acme-001");
	});

	it("is refused when an archived one has it", async () => {
		await send({ intent: "create", name: "Old", code: "OLD" });
		await send({ intent: "archive", [idField]: await idOf("Old") });
		const answer = await send({ intent: "create", name: "New", code: "old" });
		expect(answer.status).toBe(400);
		expect(answer.said).toContain(taken);
	});

	it("is refused on a rename to another's code in other capitals, and the code is kept", async () => {
		await send({ intent: "create", name: "First", code: "ONE" });
		await send({ intent: "create", name: "Second", code: "TWO" });
		const second = await idOf("Second");
		const answer = await send({ intent: "rename", [idField]: second, name: "Second", code: "one" });
		expect(answer.status).toBe(400);
		expect(answer.said).toContain(taken);
		expect(await value(`select code from ${table} where id = ?`, second)).toBe("TWO");
	});

	it("takes its own code in other capitals, and stores it as typed", async () => {
		await send({ intent: "create", name: "First", code: "ONE" });
		const first = await idOf("First");
		expect(
			(await send({ intent: "rename", [idField]: first, name: "First", code: "One" })).status,
		).toBe(200);
		expect(await value(`select code from ${table} where id = ?`, first)).toBe("One");
	});

	it("is no clash with the same code in another organisation", async () => {
		const grace = await person(mailbox, "grace@example.com");
		await createOrganisation(grace.cookie, "Initech");
		expect(
			(await send({ intent: "create", name: "Theirs", code: "SAME" }, grace, "initech")).status,
		).toBe(200);
		expect((await send({ intent: "create", name: "Ours", code: "same" })).status).toBe(200);
		expect(await count()).toBe(2);
	});

	it("is refused by the unique index when two writes both pass the check", async () => {
		const scope = organisationScope(env.DB, acme.id);
		const rows = scope[table] as unknown as {
			insert: (row: Record<string, unknown>) => Promise<unknown>;
		};
		await rows.insert({ name: "One", nameKey: "one", code: "DUP", codeKey: "dup" });
		const clash = await rows
			.insert({ name: "Two", nameKey: "two", code: "dup", codeKey: "dup" })
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(isCodeClash(clash)).toBe(true);
	});
});
