import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { type CodeRules, codeRuleFor, PROJECT_CODE_REQUIRED } from "~/lib/codes";
import { projectCodeRules } from "~/projects/projects.server";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, row, value } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";

// Under Both (TS-115a, decision 67) a work code, a project with no client that
// bills nobody, has its own code rule: Workspace settings › How you work ›
// "Every new work code has a code", which no pattern numbers, apart from the
// client projects' rule. `codeRuleFor` gives each project its rule, and
// creating, editing and importing each keep it.

const PROJECTS = "/app/acme/projects";
const SETTINGS = "/app/acme/settings";
const IMPORT = "/app/acme/integrations/import";
const WORK_CODE_NEEDED = "Enter a code: every cost centre here has one.";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };
let globex: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	await env.DB.prepare(
		"update organisations set work_model = 'both', internal_term = 'Cost centres' where id = ?",
	)
		.bind(acme.id)
		.run();
	const [client] = await organisationScope(env.DB, acme.id).clients.insert({
		name: "Globex",
		nameKey: "globex",
	});
	if (!client) throw new Error("No client was stored.");
	globex = client.id;
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** Sets the rules on Settings as its sheet does: whether projects and work codes need codes, and the pattern. */
async function setRules(projects: boolean, workCodes: boolean, pattern = "") {
	const response = await submit(
		SETTINGS,
		{
			intent: "project-codes",
			...(projects ? { required: "on" } : {}),
			...(workCodes ? { workCodeRequired: "on" } : {}),
			pattern,
		},
		ada,
		{ byScript: true },
	);
	expect(response.status).toBe(200);
	return response.text();
}

async function create(name: string, fields: Record<string, string> = {}) {
	const response = await submit(PROJECTS, { intent: "create", name, ...fields }, ada, {
		byScript: true,
	});
	return { status: response.status, said: await response.text() };
}

describe("codeRuleFor", () => {
	const rules: CodeRules = {
		required: true,
		pattern: "PRJ-0001",
		workCodes: true,
		workCodeRequired: false,
		workCode: "cost centre",
	};

	it("gives a work code under Both its own rule, which no pattern numbers", () => {
		expect(codeRuleFor(rules, true)).toEqual({
			required: false,
			pattern: null,
			problem: WORK_CODE_NEEDED,
		});
		expect(codeRuleFor({ ...rules, workCodeRequired: true }, true).required).toBe(true);
	});

	it("gives a client project the organisation's rule and pattern", () => {
		expect(codeRuleFor(rules, false)).toEqual({
			required: true,
			pattern: "PRJ-0001",
			problem: PROJECT_CODE_REQUIRED,
		});
	});

	it("gives every project the organisation's rule outside Both", () => {
		const outside = { ...rules, workCodes: false, workCodeRequired: true };
		expect(codeRuleFor(outside, true)).toEqual(codeRuleFor(outside, false));
	});

	it("is read from the organisation's settings", async () => {
		await setRules(false, true, "PRJ-0001");
		expect(await projectCodeRules(acme.id)).toEqual({
			required: false,
			pattern: "PRJ-0001",
			workCodes: true,
			workCodeRequired: true,
			workCode: "cost centre",
		});
	});
});

describe("the work-code checkbox in Settings", () => {
	it("is offered under Both alone, in the organisation's words", async () => {
		// Its row on How you work; the checkbox is in the sheet it opens (e2e/codes.spec.ts).
		const line = "Codes for cost centres, such as OPS-01, typed for each";
		expect(textOf(await pageBody(await open(SETTINGS, ada)))).toContain(line);
		await env.DB.prepare("update organisations set work_model = 'client_projects' where id = ?")
			.bind(acme.id)
			.run();
		expect(textOf(await pageBody(await open(SETTINGS, ada)))).not.toContain(line);
	});

	it("is saved and said under Both, and ignored outside it", async () => {
		expect(await setRules(false, true)).toContain("Every new cost centre needs a code.");
		expect(await value("select work_code_required from organisations")).toBe(1);
		expect(await setRules(false, false)).toContain("Codes for cost centres are optional.");
		expect(await value("select work_code_required from organisations")).toBe(0);

		await env.DB.prepare("update organisations set work_model = 'client_projects' where id = ?")
			.bind(acme.id)
			.run();
		expect(await setRules(false, true)).not.toContain("cost centre");
		expect(await value("select work_code_required from organisations")).toBe(0);
	});
});

describe("How you work's lines on codes, for any term (TS-115a)", () => {
	const lines = async () => textOf(await pageBody(await open(SETTINGS, ada)));
	const setTerm = (model: string, term: string) =>
		env.DB.prepare("update organisations set work_model = ?, internal_term = ? where id = ?")
			.bind(model, term, acme.id)
			.run();

	it.each([
		["Work codes", "Codes for work codes"],
		["Activities", "Codes for activities"],
	])("under Both with %s, say %s and never double the word", async (term, said) => {
		await setTerm("both", term);
		const text = await lines();
		expect(text).toContain(`${said}, such as OPS-01, typed for each`);
		expect(text).not.toMatch(/codes? codes/i);
	});

	it.each([
		["Work codes", "Codes for work codes"],
		["Activities", "Codes for activities"],
	])("under Internal work with %s, say %s", async (term, said) => {
		await setTerm("internal", term);
		const text = await lines();
		expect(text).toContain(`${said}, such as OPS-01, shown first wherever one appears.`);
		expect(text).not.toMatch(/codes? codes/i);
	});
});

describe("creating under Both", () => {
	it("refuses a work code without a code where work codes need one, and takes a client project", async () => {
		await setRules(false, true);
		const refused = await create("Overheads");
		expect(refused.status).toBe(400);
		expect(refused.said).toContain(WORK_CODE_NEEDED);
		expect((await create("Website", { clientId: globex })).status).toBe(200);
		expect((await create("Overheads", { code: "OPS-01" })).status).toBe(200);
		expect(
			await row("select code, billing_type, client_id from projects where name = 'Overheads'"),
		).toEqual({
			code: "OPS-01",
			billing_type: "non_billable",
			client_id: null,
		});
	});

	it("refuses a client project without a code where projects need one, and takes a work code", async () => {
		await setRules(true, false);
		const refused = await create("Website", { clientId: globex });
		expect(refused.status).toBe(400);
		expect(refused.said).toContain(PROJECT_CODE_REQUIRED);
		expect((await create("Overheads")).status).toBe(200);
		expect(await value("select code from projects where name = 'Overheads'")).toBeNull();
	});

	it("numbers a client project by the pattern, and never a work code", async () => {
		await setRules(true, false, "PRJ-0001");
		expect((await create("Website", { clientId: globex })).status).toBe(200);
		expect((await create("Overheads")).status).toBe(200);
		expect(await value("select code from projects where name = 'Website'")).toBe("PRJ-0001");
		expect(await value("select code from projects where name = 'Overheads'")).toBeNull();
	});
});

describe("editing under Both", () => {
	async function seeded() {
		const scope = organisationScope(env.DB, acme.id);
		const [work, client] = await scope.projects.insert([
			{
				name: "Overheads",
				nameKey: "overheads",
				code: "OPS-01",
				codeKey: "ops-01",
				billingType: "non_billable",
			},
			{ name: "Website", nameKey: "website", code: "GLO-1", codeKey: "glo-1", clientId: globex },
		]);
		if (!work || !client) throw new Error("No project was stored.");
		return { work: work.id, client: client.id };
	}

	async function rename(projectId: string, name: string, code: string, clientId?: string) {
		const response = await submit(
			PROJECTS,
			{ intent: "rename", projectId, name, code, ...(clientId ? { clientId } : {}) },
			ada,
			{ byScript: true },
		);
		return { status: response.status, said: await response.text() };
	}

	it("keeps each kind's code where its own rule needs one, and lets the other go", async () => {
		const { work, client } = await seeded();
		await setRules(false, true);
		const kept = await rename(work, "Overheads", "");
		expect(kept.status).toBe(400);
		expect(kept.said).toContain(WORK_CODE_NEEDED);
		expect((await rename(client, "Website", "")).status).toBe(200);

		await setRules(true, false);
		await rename(client, "Website", "GLO-1");
		const kept2 = await rename(client, "Website", "");
		expect(kept2.status).toBe(400);
		expect(kept2.said).toContain(PROJECT_CODE_REQUIRED);
		expect((await rename(work, "Overheads", "")).status).toBe(200);
	});

	it("judges a work code given a client by the client projects' rule", async () => {
		const { work } = await seeded();
		await setRules(true, false);
		const moved = await rename(work, "Overheads", "", globex);
		expect(moved.status).toBe(400);
		expect(moved.said).toContain(PROJECT_CODE_REQUIRED);
		expect(await row("select code, client_id from projects where id = ?", work)).toEqual({
			code: "OPS-01",
			client_id: null,
		});
	});
});

describe("importing under Both", () => {
	async function preview(text: string) {
		const body = new FormData();
		body.set("intent", "upload");
		body.set("kind", "projects");
		body.set("file", new File([text], "projects.csv", { type: "text/csv" }));
		const response = await exports.default.fetch(
			new Request(`${ORIGIN}${IMPORT}?kind=projects`, {
				method: "POST",
				headers: { Origin: ORIGIN, Cookie: ada.cookie, "CF-Connecting-IP": ada.client },
				body,
				redirect: "manual",
			}),
		);
		expect(response.status).toBe(302);
		const location = response.headers.get("Location") ?? "";
		return {
			id: new URL(location, ORIGIN).searchParams.get("import") ?? "",
			page: textOf(await (await open(location, ada)).text()),
		};
	}

	const CSV =
		"Client,Project,Project code\r\nGlobex,Website,\r\n,Overheads,\r\n,Facilities,FAC-1\r\n";

	it("skips a work code without a code where work codes need one, and keeps the client project", async () => {
		await setRules(false, true);
		const { id, page } = await preview(CSV);
		expect(page).toContain("No cost centre code: every cost centre here needs one.");
		expect(page).toContain("2 to import, 1 to skip.");
		await submit(`${IMPORT}?kind=projects`, { intent: "import", importId: id }, ada);
		const names = await env.DB.prepare(
			"select name, code, billing_type from projects order by name",
		).all();
		expect(names.results).toEqual([
			{ name: "Facilities", code: "FAC-1", billing_type: "non_billable" },
			{ name: "Website", code: null, billing_type: "hourly" },
		]);
	});

	it("numbers the client projects it adds by the pattern, and leaves the work codes as the file gives them", async () => {
		await setRules(true, false, "PRJ-0001");
		const { id } = await preview(CSV);
		await submit(`${IMPORT}?kind=projects`, { intent: "import", importId: id }, ada);
		const names = await env.DB.prepare("select name, code from projects order by name").all();
		expect(names.results).toEqual([
			{ name: "Facilities", code: "FAC-1" },
			{ name: "Overheads", code: null },
			{ name: "Website", code: "PRJ-0001" },
		]);
	});
});
