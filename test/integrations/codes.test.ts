import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import {
	addEstimateLine,
	createEstimate,
	ESTIMATE_PROJECT_NEEDS_CODE,
	ESTIMATE_PROJECT_NOT_ALLOWED,
	projectFromEstimate,
	recordDecision,
} from "~/estimates/estimates.server";
import { makeToken } from "~/integrations/api-tokens.server";
import { API_SCOPES } from "~/integrations/scopes";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMembership,
	value,
} from "../organisations/harness";
import { open, type Person, person, submit, textOf } from "../pages/harness";
import { seedEntry, seedProject } from "../pages/periods-seed";

// Codes on clients and projects (TS-115a) where they leave and enter
// Timesifier: the API names each client and project with its code, the CSV
// import finds a project by its code before its name and gives what it adds
// the file's codes, and starting a project from an estimate is for owners,
// admins and the client's account managers alone (decision 42).

const IMPORT = "/app/acme/integrations/import";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };
let scope: OrganisationScope;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	await env.DB.prepare("update users set name = 'Ada Lovelace' where id = ?")
		.bind(ada.user.id)
		.run();
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

/** Initech, coded INI, and its project Apollo, coded INI-001. */
async function seedCoded() {
	const [client] = await scope.clients.insert({
		name: "Initech",
		nameKey: "initech",
		code: "INI",
		codeKey: "ini",
	});
	if (!client) throw new Error("seed failed");
	const apollo = await seedProject(acme.id, "Apollo");
	await env.DB.prepare(
		"update projects set client_id = ?, code = 'INI-001', code_key = 'ini-001' where id = ?",
	)
		.bind(client.id, apollo)
		.run();
	return { clientId: client.id, apollo };
}

function api(path: string, token: string): Promise<Response> {
	return exports.default.fetch(
		new Request(`${ORIGIN}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } }),
	);
}

async function data<T>(response: Response): Promise<T> {
	expect(response.status).toBe(200);
	// The API's own answer, of the shape docs/openapi.yaml gives it.
	const body = (await response.json()) as { data: T };
	return body.data;
}

describe("the API", () => {
	it("gives each client and project its code, and the client's on a project", async () => {
		const { clientId, apollo } = await seedCoded();
		const uncoded = await seedProject(acme.id, "Hermes");
		const token = await makeToken(scope, ada.user.id, "Test", API_SCOPES);

		const clients = await data<{ id: string; code: string | null }[]>(await api("/clients", token));
		expect(clients).toEqual([expect.objectContaining({ id: clientId, code: "INI" })]);

		const projects = await data<{ id: string; code: string | null; client: unknown }[]>(
			await api("/projects", token),
		);
		expect(projects.find((p) => p.id === apollo)).toMatchObject({
			code: "INI-001",
			client: { id: clientId, name: "Initech", code: "INI" },
		});
		expect(projects.find((p) => p.id === uncoded)).toMatchObject({ code: null, client: null });
	});

	it("names each entry's project and client with their codes", async () => {
		const { clientId, apollo } = await seedCoded();
		await seedEntry(acme.id, ada.user.id, apollo, "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z");
		const token = await makeToken(scope, ada.user.id, "Test", API_SCOPES);

		const [entry] = await data<{ project: unknown; client: unknown }[]>(
			await api("/time_entries?from=2026-11-01&to=2026-11-30", token),
		);
		expect(entry?.project).toEqual({ id: apollo, name: "Apollo", code: "INI-001" });
		expect(entry?.client).toEqual({ id: clientId, name: "Initech", code: "INI" });
	});
});

/** Uploads `text` as a CSV of `kind` as the page's form does; the address it is previewed at. */
async function upload(text: string, kind = "time") {
	const body = new FormData();
	body.set("intent", "upload");
	body.set("kind", kind);
	body.set("file", new File([text], "codes.csv", { type: "text/csv" }));
	const response = await exports.default.fetch(
		new Request(`${ORIGIN}${IMPORT}?kind=${kind}`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: ada.cookie, "CF-Connecting-IP": ada.client },
			body,
			redirect: "manual",
		}),
	);
	expect(response.status).toBe(302);
	return response.headers.get("Location") ?? "";
}

/** Uploads and imports `text`; the import's id. */
async function importFile(text: string, kind = "time") {
	const location = await upload(text, kind);
	const id = new URL(location, ORIGIN).searchParams.get("import") ?? "";
	const imported = await submit(`${IMPORT}?kind=${kind}`, { intent: "import", importId: id }, ada);
	expect(imported.status).toBe(302);
	return id;
}

describe("the CSV import", () => {
	it("lands a row whose Project cell is a code on that project, whatever its case", async () => {
		const { apollo } = await seedCoded();
		const id = await importFile(
			"Date,Project,Task,Notes,Hours,Email\r\n2026-10-05,ini-001,,By code,1,ada@example.com\r\n",
		);
		expect(
			await row("select project_id, description from time_entries where import_id = ?", id),
		).toEqual({ project_id: apollo, description: "By code" });
		expect(await value("select count(*) from projects")).toBe(1);
	});

	it("reads a Project code column before the name, and gives a project it adds that code", async () => {
		const { apollo } = await seedCoded();
		const csv = [
			"Date,Client,Project,Project code,Hours,Email",
			// The code wins over a name that is another project's.
			"2026-10-05,Initech,Somewhere else,INI-001,1,ada@example.com",
			"2026-10-06,Initech,Zeus,ZEU-7,2,ada@example.com",
			// Named by its new code alone: the same new project, added once.
			"2026-10-07,,zeu-7,,3,ada@example.com",
		].join("\r\n");
		const page = textOf(await (await open(await upload(csv), ada)).text());
		expect(page).toContain("It adds projects ZEU-7 · Zeus.");
		expect(page).toContain("Ada Lovelace · INI-001 · Apollo");

		const id = await importFile(csv);
		const zeus = await row<{ id: string; code: string; code_key: string; client_id: string }>(
			"select id, code, code_key, client_id from projects where name = 'Zeus'",
		);
		expect(zeus).toMatchObject({ code: "ZEU-7", code_key: "zeu-7" });
		expect(await value("select name from clients where id = ?", zeus?.client_id)).toBe("Initech");
		const placed = await env.DB.prepare(
			"select project_id from time_entries where import_id = ? order by spent_on",
		)
			.bind(id)
			.all<{ project_id: string }>();
		expect(placed.results.map((r) => r.project_id)).toEqual([apollo, zeus?.id, zeus?.id]);
	});

	it("adds projects and clients with their codes, and skips one whose code is already here", async () => {
		await seedCoded();
		await importFile(
			[
				"Client code,Client,Project code,Project",
				"UMB,Umbrella,UMB-001,Hive",
				"INI,Whatever,INI-001,Apollo again",
			].join("\r\n"),
			"projects",
		);
		expect(await row("select code, code_key from projects where name = 'Hive'")).toEqual({
			code: "UMB-001",
			code_key: "umb-001",
		});
		expect(await row("select code, code_key from clients where name = 'Umbrella'")).toEqual({
			code: "UMB",
			code_key: "umb",
		});
		expect(await value("select count(*) from projects where name = 'Apollo again'")).toBe(0);
	});

	it("skips a project it would add without a code where every project needs one and none is numbered", async () => {
		await env.DB.prepare("update organisations set project_code_required = 1 where id = ?")
			.bind(acme.id)
			.run();
		const page = textOf(
			await (
				await open(await upload("Client,Project\r\nUmbrella,Hive\r\n", "projects"), ada)
			).text(),
		);
		expect(page).toContain("No project code: every project here needs one.");
		expect(page).toContain("0 to import, 1 to skip.");
	});

	it("says the organisation's term under Internal work, and has no clients", async () => {
		await env.DB.prepare(
			"update organisations set work_model = 'internal', internal_term = 'Cost centres' where id = ?",
		)
			.bind(acme.id)
			.run();
		const page = textOf(await (await open(`${IMPORT}?kind=projects`, ada)).text());
		expect(page).toContain("Import cost centres");
		expect(page).not.toMatch(/\bprojects?\b/i);
		expect((await open(`${IMPORT}?kind=clients`, ada)).status).toBe(404);
	});
});

describe("starting a project from an estimate", () => {
	/** An accepted estimate for Initech, of one line. */
	async function accepted(clientId: string) {
		const made = await createEstimate(scope, ada.user.id, {
			clientId,
			currency: "GBP",
			issuedOn: "2026-11-02",
			poNumber: null,
			subject: "Website",
			notes: null,
			discountBasisPoints: 0,
		});
		if (!made?.ok) throw new Error("no estimate");
		const line = await addEstimateLine(scope, ada.user.id, made.id, {
			description: "Design",
			quantityMilli: 1000,
			unitPriceMinor: 50_000,
			taxId: null,
			secondTaxId: null,
		});
		expect(line?.ok).toBe(true);
		await recordDecision(scope, ada.user.id, made.id, "accepted", new Date("2026-11-02T12:00:00Z"));
		return made.id;
	}

	it("is refused to a member or Finance who is not an account manager of the client", async () => {
		const { clientId } = await seedCoded();
		const id = await accepted(clientId);
		for (const [role, email] of [
			["member", "max@example.com"],
			["finance", "fin@example.com"],
		] as const) {
			const who = await memberOfAcme(role, email);
			expect(await projectFromEstimate(scope, who.user.id, id)).toEqual({
				ok: false,
				problem: ESTIMATE_PROJECT_NOT_ALLOWED,
			});
		}
		expect(await value("select count(*) from projects where name = 'Website'")).toBe(0);
	});

	it("is allowed to an account manager of the client, with no code", async () => {
		const { clientId } = await seedCoded();
		const id = await accepted(clientId);
		const max = await memberOfAcme("member", "max@example.com");
		await scope.clientManagers.insert({ clientId, userId: max.user.id });
		expect(await projectFromEstimate(scope, max.user.id, id)).toMatchObject({
			ok: true,
			name: "Website",
		});
		expect(await row("select client_id, code from projects where name = 'Website'")).toEqual({
			client_id: clientId,
			code: null,
		});
	});

	it("is refused where every project needs a code and no pattern numbers it", async () => {
		const { clientId } = await seedCoded();
		const id = await accepted(clientId);
		await env.DB.prepare("update organisations set project_code_required = 1 where id = ?")
			.bind(acme.id)
			.run();
		expect(await projectFromEstimate(scope, ada.user.id, id)).toEqual({
			ok: false,
			problem: ESTIMATE_PROJECT_NEEDS_CODE,
		});
	});
});
