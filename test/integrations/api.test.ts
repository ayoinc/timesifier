import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { API_RATE_LIMIT, makeToken } from "~/integrations/api-tokens.server";
import { API_SCOPES, type ApiScope } from "~/integrations/scopes";
import { hashApiToken } from "~/integrations/tokens.server";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, person, submit } from "../pages/harness";
import { seedLeave } from "../pages/leave-seed";
import { seedEntry, seedPeriod, seedProject } from "../pages/periods-seed";

// The public API (TS-081): tokens made and revoked on Integrations, shown
// once and kept as a keyed hash; each request acts as the token's maker with
// their role as it is, within the token's scopes; writes go in the activity
// log "via API"; each token is rate limited. Every request goes through the
// Worker's fetch handler.

const INTEGRATIONS = "/app/acme/integrations";
const TOKEN = /tsf_[A-Za-z0-9_-]{43}/;

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	await env.DB.prepare("update users set name = ? where id = ?")
		.bind("Ada Lovelace", ada.user.id)
		.run();
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

function api(
	path: string,
	token: string | null,
	{ method = "GET", body }: { method?: string; body?: unknown } = {},
): Promise<Response> {
	const headers = new Headers();
	if (token) headers.set("Authorization", `Bearer ${token}`);
	if (body !== undefined) headers.set("Content-Type", "application/json");
	return exports.default.fetch(
		new Request(`${ORIGIN}/api/v1${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

/** A person of `role` in Acme with name `name`. */
async function memberOfAcme(role: Role, email: string, name: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	await env.DB.prepare("update users set name = ? where id = ?").bind(name, who.user.id).run();
	return who;
}

/** A token for `who`, with every scope unless named, made the way the page makes one. */
function tokenFor(who: Person, scopes: readonly ApiScope[] = API_SCOPES) {
	return makeToken(organisationScope(env.DB, acme.id), who.user.id, "Test", scopes);
}

describe("tokens on Integrations", () => {
	it("an owner makes a token: shown once, tsf_, kept as a keyed hash, with the scopes chosen", async () => {
		const body = new URLSearchParams([
			["intent", "token-create"],
			["name", "Zapier"],
			["scopes", "time:read"],
			["scopes", "time:write"],
		]);
		const made = await exports.default.fetch(
			new Request(`${ORIGIN}${INTEGRATIONS}.data`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Origin: ORIGIN,
					Cookie: ada.cookie,
					"CF-Connecting-IP": ada.client,
				},
				body,
			}),
		);
		expect(made.status).toBe(200);
		const token = (await made.text()).match(TOKEN)?.[0] ?? "";
		expect(token).toMatch(TOKEN);

		const stored = await row<{ token_hash: string; prefix: string; scopes: string }>(
			"select token_hash, prefix, scopes from api_tokens",
		);
		expect(stored?.token_hash).toBe(await hashApiToken(env.BETTER_AUTH_SECRET, token));
		expect(stored?.token_hash).not.toContain(token.slice(4));
		expect(stored?.prefix).toBe(token.slice(4, 12));
		expect(JSON.parse(stored?.scopes ?? "[]")).toEqual(["time:read", "time:write"]);

		// The page lists it by its prefix and never shows the token again.
		const page = await (await open(INTEGRATIONS, ada)).text();
		expect(page).toContain(`tsf_${token.slice(4, 12)}`);
		expect(page).not.toContain(token);
		expect(page).toContain("Never used.");

		expect((await api("/me", token)).status).toBe(200);
		const used = await value<number>("select last_used_at from api_tokens");
		expect(used).toBeGreaterThan(0);
		expect(await (await open(INTEGRATIONS, ada)).text()).toContain("Last used");
		// The scope it was not given is refused.
		expect((await api("/projects", token)).status).toBe(403);
		expect(
			await value("select count(*) from activity_records where action = 'api_token.created'"),
		).toBe(1);
	});

	it("a revoked token is refused at once", async () => {
		const token = await tokenFor(ada);
		expect((await api("/me", token)).status).toBe(200);
		const id = await value<string>("select id from api_tokens");
		const revoked = await submit(INTEGRATIONS, { intent: "token-revoke", tokenId: id ?? "" }, ada, {
			byScript: true,
		});
		expect(revoked.status).toBe(200);
		const refused = await api("/me", token);
		expect(refused.status).toBe(401);
		expect(refused.headers.get("WWW-Authenticate")).toContain("Bearer");
		expect(
			await value("select count(*) from activity_records where action = 'api_token.revoked'"),
		).toBe(1);
	});

	it("refuses no token, a malformed one and an unknown one alike", async () => {
		for (const token of [null, "tsf_short", `tsf_${"A".repeat(43)}`]) {
			expect((await api("/me", token)).status).toBe(401);
		}
	});

	it("is refused to a member, a manager and Finance, page and action alike", async () => {
		for (const [role, email] of [
			["member", "mo@example.com"],
			["finance", "fin@example.com"],
		] as const) {
			const who = await memberOfAcme(role, email, email);
			expect((await open(INTEGRATIONS, who)).status).toBe(404);
			expect(
				(
					await submit(
						INTEGRATIONS,
						{ intent: "token-create", name: "x", scopes: "time:read" },
						who,
					)
				).status,
			).toBe(404);
		}
		expect(await value("select count(*) from api_tokens")).toBe(0);
	});

	it("stops working when its maker leaves the organisation", async () => {
		const ben = await memberOfAcme("admin", "ben@example.com", "Ben Admin");
		const token = await tokenFor(ben);
		expect((await api("/me", token)).status).toBe(200);
		await env.DB.prepare("delete from memberships where user_id = ?").bind(ben.user.id).run();
		expect((await api("/me", token)).status).toBe(401);
	});
});

describe("the same role rules as the pages", () => {
	// Acme: Ada owns it; Ben is an admin, Fin is Finance, Mia manages a team
	// holding Max, Max and Cy are members, Cy a contractor outside any team.
	async function people() {
		const ben = await memberOfAcme("admin", "ben@example.com", "Ben Admin");
		const fin = await memberOfAcme("finance", "fin@example.com", "Fin Ance");
		const mia = await memberOfAcme("member", "mia@example.com", "Mia Manager");
		const max = await memberOfAcme("member", "max@example.com", "Max Member");
		const cy = await memberOfAcme("member", "cy@example.com", "Cy Contractor");
		await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
			.bind(cy.user.id)
			.run();
		await seedTeam(acme.id, "Design", { members: [max.user.id], managers: [mia.user.id] });
		const apollo = await seedProject(acme.id, "Apollo");
		const entries = new Map<string, string>();
		for (const [who, hour] of [
			[ada, 9],
			[ben, 10],
			[fin, 11],
			[mia, 12],
			[max, 13],
			[cy, 14],
		] as const) {
			entries.set(
				who.user.id,
				await seedEntry(
					acme.id,
					who.user.id,
					apollo,
					`2026-11-02T${String(hour).padStart(2, "0")}:00:00Z`,
					`2026-11-02T${String(hour).padStart(2, "0")}:30:00Z`,
					`Notes of ${who.user.email}`,
				),
			);
		}
		return { ben, fin, mia, max, cy, apollo, entries };
	}

	const seen = async (token: string) =>
		(
			await json<{ data: { user: { name: string } }[] }>(
				await api("/time_entries?from=2026-11-01&to=2026-11-30", token),
			)
		).data
			.map((entry) => entry.user.name)
			.sort();

	it("time entries: everyone's for owner, admin and Finance; a manager's team and their own; a member's own", async () => {
		const { ben, fin, mia, max, cy } = await people();
		const everyone = [
			"Ada Lovelace",
			"Ben Admin",
			"Cy Contractor",
			"Fin Ance",
			"Max Member",
			"Mia Manager",
		];
		expect(await seen(await tokenFor(ada))).toEqual(everyone);
		expect(await seen(await tokenFor(ben))).toEqual(everyone);
		expect(await seen(await tokenFor(fin))).toEqual(everyone);
		expect(await seen(await tokenFor(mia))).toEqual(["Max Member", "Mia Manager"]);
		expect(await seen(await tokenFor(max))).toEqual(["Max Member"]);
		expect(await seen(await tokenFor(cy))).toEqual(["Cy Contractor"]);
	});

	it("an entry out of reach is 404, as on the pages, and descriptions need their scope", async () => {
		const { max, entries } = await people();
		const maxToken = await tokenFor(max);
		expect((await api(`/time_entries/${entries.get(ada.user.id)}`, maxToken)).status).toBe(404);
		const own = await json(await api(`/time_entries/${entries.get(max.user.id)}`, maxToken));
		expect(own.description).toBe("Notes of max@example.com");
		expect(own.spent_date).toBe("2026-11-02");
		expect(own.hours).toBe(0.5);
		const plain = await tokenFor(max, ["time:read"]);
		expect(
			await json(await api(`/time_entries/${entries.get(max.user.id)}`, plain)),
		).not.toHaveProperty("description");
	});

	it("users, clients, projects and invoices follow who may see people and money", async () => {
		const { fin, mia, max } = await people();
		const names = async (token: string) =>
			(await json<{ data: { name: string; email?: string }[] }>(await api("/users", token))).data;
		expect((await names(await tokenFor(ada))).length).toBe(6);
		expect((await names(await tokenFor(ada)))[0]).toHaveProperty("email");
		expect((await names(await tokenFor(fin)))[0]).not.toHaveProperty("email");
		expect((await names(await tokenFor(mia))).map((p) => p.name).sort()).toEqual([
			"Max Member",
			"Mia Manager",
		]);
		expect((await names(await tokenFor(max))).map((p) => p.name)).toEqual(["Max Member"]);

		// Clients: those shown Clients, and nobody else.
		expect((await api("/clients", await tokenFor(fin))).status).toBe(200);
		expect((await api("/clients", await tokenFor(mia))).status).toBe(403);
		expect((await api("/clients", await tokenFor(max))).status).toBe(403);
		// Invoices: those who invoice.
		expect((await api("/invoices", await tokenFor(fin))).status).toBe(200);
		expect((await api("/invoices", await tokenFor(max))).status).toBe(403);
		// Projects: everyone; money only for those who see it.
		const [ownerProject] = (
			await json<{ data: Record<string, unknown>[] }>(await api("/projects", await tokenFor(ada)))
		).data;
		const [memberProject] = (
			await json<{ data: Record<string, unknown>[] }>(await api("/projects", await tokenFor(max)))
		).data;
		expect(ownerProject).toHaveProperty("billing_type");
		expect(memberProject).not.toHaveProperty("billing_type");
		expect(memberProject?.name).toBe("Apollo");
	});

	it("leave: everyone sees who is away; the kind only where the pages show it", async () => {
		const { fin, mia, max } = await people();
		await seedLeave(acme.id, max.user.id, "sick", "2026-11-09", "2026-11-10");
		const kindSeenBy = async (token: string) =>
			(await json<{ data: { kind: { name: string } | null }[] }>(await api("/leave", token)))
				.data[0]?.kind?.name ?? null;
		expect(await kindSeenBy(await tokenFor(max))).toBe("Sick leave");
		expect(await kindSeenBy(await tokenFor(mia))).toBe("Sick leave");
		expect(await kindSeenBy(await tokenFor(ada))).toBe("Sick leave");
		expect(await kindSeenBy(await tokenFor(fin))).toBeNull();
	});

	it("writes: a person's own entries only, via API in the activity log, and locked days refused", async () => {
		const { max, apollo, entries } = await people();
		const token = await tokenFor(max);

		const made = await api("/time_entries", token, {
			method: "POST",
			body: { project_id: apollo, spent_date: "2026-11-03", hours: 1.5, description: "Pairing" },
		});
		expect(made.status).toBe(201);
		const entry = await json(made);
		expect(entry.hours).toBe(1.5);
		expect(entry.spent_date).toBe("2026-11-03");
		const recorded = await row<{
			source: string;
			actor_id: string;
			owner_id: string;
			subject_type: string;
			action: string;
		}>(
			"select source, actor_id, owner_id, subject_type, action from activity_records where subject_id = ?",
			entry.id,
		);
		expect(recorded).toEqual({
			source: "api",
			actor_id: max.user.id,
			owner_id: max.user.id,
			subject_type: "time_entry",
			action: "time_entry.created",
		});

		const changed = await api(`/time_entries/${entry.id}`, token, {
			method: "PATCH",
			body: { hours: 2 },
		});
		expect(changed.status).toBe(200);
		expect((await json(changed)).hours).toBe(2);

		// Nobody else's: not by naming them, not by their entry's id.
		expect(
			(
				await api("/time_entries", token, {
					method: "POST",
					body: { user_id: ada.user.id, project_id: apollo, spent_date: "2026-11-03", hours: 1 },
				})
			).status,
		).toBe(403);
		const adaToken = await tokenFor(ada);
		expect(
			(await api(`/time_entries/${entries.get(max.user.id)}`, adaToken, { method: "DELETE" }))
				.status,
		).toBe(403);

		// A submitted week is locked for the API as for the page.
		await seedPeriod(acme.id, max.user.id, "2026-11-02");
		expect((await api(`/time_entries/${entry.id}`, token, { method: "DELETE" })).status).toBe(409);
		await env.DB.prepare("delete from periods").run();
		expect((await api(`/time_entries/${entry.id}`, token, { method: "DELETE" })).status).toBe(204);
		expect(
			await value(
				"select count(*) from activity_records where source = 'api' and subject_id = ?",
				entry.id,
			),
		).toBe(3);
	});

	it("checks what it is sent", async () => {
		const { max, apollo } = await people();
		const token = await tokenFor(max);
		const invalid = await api("/time_entries", token, {
			method: "POST",
			body: { project_id: apollo, spent_date: "2026-02-31", hours: 30 },
		});
		expect(invalid.status).toBe(422);
		expect(Object.keys((await json<{ error: { fields: object } }>(invalid)).error.fields)).toEqual(
			expect.arrayContaining(["spent_date", "hours"]),
		);
		expect((await api("/time_entries", token, { method: "PUT", body: {} })).status).toBe(405);
		expect((await api("/nothing", token)).status).toBe(404);
		const noScope = await tokenFor(max, ["time:read"]);
		expect(
			(
				await api("/time_entries", noScope, {
					method: "POST",
					body: { project_id: apollo, spent_date: "2026-11-03", hours: 1 },
				})
			).status,
		).toBe(403);
	});

	it("reaches nothing of another organisation", async () => {
		const { apollo } = await people();
		const eve = await person(mailbox, "eve@example.com");
		const globex = await createOrganisation(eve.cookie, "Globex");
		const eveToken = await makeToken(
			organisationScope(env.DB, globex.id),
			eve.user.id,
			"Eve",
			API_SCOPES,
		);
		expect((await json<{ data: unknown[] }>(await api("/projects", eveToken))).data).toEqual([]);
		expect((await json<{ data: unknown[] }>(await api("/time_entries", eveToken))).data).toEqual(
			[],
		);
		expect(
			(
				await api("/time_entries", eveToken, {
					method: "POST",
					body: { project_id: apollo, spent_date: "2026-11-03", hours: 1 },
				})
			).status,
		).toBe(422);
	});
});

describe("the rate limit", () => {
	it("answers 429 with Retry-After once a token has used its requests, and only that token", async () => {
		const token = await tokenFor(ada);
		const other = await tokenFor(ada);
		for (let used = 0; used < API_RATE_LIMIT.max; used++) {
			expect((await api("/me", token)).status).toBe(200);
		}
		const limited = await api("/me", token);
		expect(limited.status).toBe(429);
		const wait = Number(limited.headers.get("Retry-After"));
		expect(wait).toBeGreaterThanOrEqual(1);
		expect(wait).toBeLessThanOrEqual(API_RATE_LIMIT.seconds);
		expect((await api("/me", other)).status).toBe(200);
	});
});
