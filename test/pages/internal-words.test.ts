import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership } from "../organisations/harness";
import { open, type Person, pageBody, person } from "./harness";

// Under Internal work (TS-115a, decision 67) the organisation's own term is
// the only word for what time goes to: no word "Project" or "Client" is shown
// on Projects, on a project's page or in Workspace settings, nor in any sheet
// they open, nor in what a screen reader reads out (labels and titles), to an
// owner or to a member.

const TERM = "Cost centres";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };
let projectId: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	await env.DB.prepare(
		"update organisations set work_model = 'internal', internal_term = ?, project_code_pattern = 'OPS-01', project_code_next = 2 where id = ?",
	)
		.bind(TERM, acme.id)
		.run();
	const scope = organisationScope(env.DB, acme.id);
	const [operations] = await scope.projects.insert([
		{ name: "Operations", nameKey: "operations", code: "OPS-01", codeKey: "ops-01" },
		{ name: "Old", nameKey: "old", archivedAt: new Date() },
	]);
	if (!operations) throw new Error("No project was stored.");
	projectId = operations.id;
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The words of a page a person may see or hear: the text of its `<main>` and
 * of the sheets it opens, and its labels and titles, with the addresses and
 * names the code gives its forms (which nobody sees) left out.
 */
function wordsOf(html: string): string {
	const main = /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
	const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "";
	const spoken = [...main.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]*)"/g)].map(
		([, said]) => said,
	);
	const text = main
		.replace(/<script[\s\S]*?<\/script>/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&[a-z#0-9]+;/g, " ");
	return [title, ...spoken, text].join(" ").replace(/\s+/g, " ");
}

/** Each "Project" or "Client" in some words, with the words around it. */
const forbidden = (said: string) =>
	[...said.matchAll(/.{0,40}\b(?:projects?|clients?)\b.{0,40}/gi)].map(([found]) => found);

async function words(path: string, who: Person) {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return wordsOf(await pageBody(response));
}

describe("the words under Internal work", () => {
	const pages = () => [
		"/app/acme/projects",
		"/app/acme/projects?archived=1",
		`/app/acme/projects/${projectId}`,
		"/app/acme/settings",
	];

	it("an owner is shown no Project or Client on Projects, a project's page or Settings", async () => {
		const found: Record<string, string[]> = {};
		for (const path of pages()) found[path] = forbidden(await words(path, ada));
		expect(found).toEqual(Object.fromEntries(pages().map((path) => [path, []])));
	});

	it("each of those pages says the organisation's term", async () => {
		expect(await words("/app/acme/projects", ada)).toContain(TERM);
		expect(await words(`/app/acme/projects/${projectId}`, ada)).toContain("OPS-01");
		expect(await words("/app/acme/settings", ada)).toContain("cost centres");
	});

	it("a member is shown none on Projects or a project's page", async () => {
		const max = await person(mailbox, "max@example.com");
		await seedMembership(acme.id, max.user.id, "member");
		for (const path of pages().slice(0, 3)) {
			const response = await open(path, max);
			if (response.status === 404) continue;
			const said = wordsOf(await pageBody(response));
			expect(forbidden(said), path).toEqual([]);
		}
	});
});
