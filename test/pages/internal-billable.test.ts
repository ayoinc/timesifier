import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { projectPath } from "~/projects/projects";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation } from "../organisations/harness";
import { open, type Person, pageBody, person, textOf } from "./harness";

// Under Internal work nothing is billable (TS-115a), so nothing says whether
// it is: no Billable or Non-billable, no billable amount and no way of billing
// on a project's page, and none in Reports. The same pages under Client
// projects do say it, so each check below is of something that was there.
// Track time's task field is checked in the browser (e2e/codes.spec.ts),
// where its sheet opens.

let ada: Person;
let acme: { id: string };
let projectId: string;

beforeEach(async () => {
	await freshDatabase();
	const mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	const scope = organisationScope(env.DB, acme.id);
	// An hourly project from before a switch to Internal work, with a billable task.
	const [project] = await scope.projects.insert({
		name: "Operations",
		nameKey: "operations",
		billingType: "hourly",
	});
	const [task] = await scope.tasks.insert({
		name: "Support",
		nameKey: "support",
		billableByDefault: true,
	});
	if (!project || !task) throw new Error("seed failed");
	projectId = project.id;
	await scope.projectTasks.insert({ projectId, taskId: task.id, billable: true });
	const started = Date.now() - 2 * 3_600_000;
	await scope.timeEntries.insert({
		userId: ada.user.id,
		projectId,
		taskId: task.id,
		billable: true,
		description: null,
		startedAt: new Date(started),
		spentOn: new Date(started).toISOString().slice(0, 10),
		endedAt: new Date(started + 3_600_000),
	});
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const PAGES = () => [
	projectPath("acme", projectId),
	projectPath("acme", projectId, "tasks"),
	projectPath("acme", projectId, "settings"),
	"/app/acme/reports",
	"/app/acme/reports/utilisation",
	"/app/acme/reports/expenses",
	"/app/acme/reports/profitability",
];

/** The words of the page's `<main>`, and its labels, as a person sees or hears them. */
async function wordsOf(path: string) {
	const response = await open(path, ada);
	expect(response.status, path).toBe(200);
	const main = /<main[\s\S]*<\/main>/.exec(await pageBody(response))?.[0] ?? "";
	const labels = [...main.matchAll(/\baria-label="([^"]*)"/g)].map(([, said]) => said);
	return `${textOf(main)} ${labels.join(" ")}`;
}

const setModel = (model: string) =>
	env.DB.prepare("update organisations set work_model = ? where id = ?").bind(model, acme.id).run();

/** Each mention of billing in some words, with the words around it. */
const billing = (said: string) =>
	[...said.matchAll(/.{0,40}\b(?:billable|non-billable|billing|hourly|bills)\b.{0,40}/gi)].map(
		([found]) => found,
	);

describe("billable under Internal work", () => {
	it("is said on a project's page and in Reports under Client projects", async () => {
		await setModel("client_projects");
		for (const path of PAGES().filter((path) => !path.endsWith("profitability"))) {
			expect(billing(await wordsOf(path)), path).not.toEqual([]);
		}
	});

	it("is said nowhere on a project's page or in Reports under Internal work", async () => {
		await setModel("internal");
		for (const path of PAGES()) expect(billing(await wordsOf(path)), path).toEqual([]);
	});

	it("is said nowhere even of a project that billed before the switch, to the hours' total", async () => {
		await setModel("internal");
		const overview = await wordsOf(projectPath("acme", projectId));
		expect(overview).toContain("Total hours");
		expect(overview).not.toContain("Profit");
	});
});
