import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { makeToken } from "~/integrations/api-tokens.server";
import { makeFeed } from "~/integrations/feeds.server";
import { FEED_PATH } from "~/integrations/paths";
import { API_SCOPES } from "~/integrations/scopes";
import { COMPANY_SIGN_IN_REQUIRED } from "~/organisations/problems";
import { meetsPolicy, policyOf } from "~/organisations/sign-in-policy";
import { destinationPath, organisationPath, signInSettingsPath } from "~/shell/destinations";
import { captureEmail, get, type Mailbox, ORIGIN, post, setBinding } from "../auth/harness";
import {
	ACME_TENANT,
	configureProviders,
	googleClaims,
	microsoftClaims,
	signInWith,
} from "../auth/social-harness";
import { freshDatabase } from "../db/database";
import { open, openData, type Person, person, submit, textOf } from "../pages/harness";
import { allRoutes, isMoved } from "../routes";
import { type Role, row, seedMembership, seedOrganisation, seedTeam } from "./harness";

// TS-104 slice 104b: an organisation may require company sign-in. Its pages,
// their forms and the organisation API then open for a member only when their
// session was made with the provider (and tenant) it names; its owners are
// exempt (the owner's answer 7). Settings › Sign-in, where the policy is
// chosen, is the owners' and admins' alone.

let mailbox: Mailbox;
let acme: { id: string };

const ACME = "acme";
const OTHER_TENANT = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const settings = signInSettingsPath(ACME);

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	configureProviders("google", "microsoft");
	acme = await seedOrganisation("Acme", ACME);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Somebody signed in with an emailed code, holding `role` in Acme. */
async function byCode(email: string, role: Role | null): Promise<Person> {
	const who = await person(mailbox, email);
	if (role) await seedMembership(acme.id, who.user.id, role);
	return who;
}

let microsoftClients = 0;

/** Somebody signed in with a Microsoft work account in `tenant`, holding `role` in Acme. */
async function byMicrosoft(
	email: string,
	role: Role | null,
	tenant = ACME_TENANT,
): Promise<Person> {
	microsoftClients += 1;
	const client = `203.0.113.${(microsoftClients % 250) + 1}`;
	const { cookie } = await signInWith("microsoft", microsoftClaims(email, {}, tenant), { client });
	if (!cookie) throw new Error(`Microsoft did not sign ${email} in.`);
	const user = await row<{ id: string; email: string }>(
		"select id, email from users where email = ?",
		email,
	);
	if (!user) throw new Error(`No account for ${email}.`);
	if (role) await seedMembership(acme.id, user.id, role);
	return { cookie, client, user };
}

/** Sets Acme's policy directly, as a change through Settings would leave it. */
async function requireForAcme(provider: "google" | "microsoft", tenant: string | null = null) {
	await env.DB.prepare(
		"update organisations set sign_in_policy = 'company', sign_in_provider = ?, sign_in_tenant = ? where id = ?",
	)
		.bind(provider, tenant, acme.id)
		.run();
}

async function policyOfAcme() {
	return row<{
		sign_in_policy: string;
		sign_in_provider: string | null;
		sign_in_tenant: string | null;
	}>(
		"select sign_in_policy, sign_in_provider, sign_in_tenant from organisations where id = ?",
		acme.id,
	);
}

/** Posts the policy form of Settings › Sign-in as `who`, by script, and returns the answer. */
function choose(who: Person, policy: "any" | "google" | "microsoft", tenant = "") {
	return submit(settings, { intent: "policy", policy, tenant }, who, { byScript: true });
}

const timesheet = destinationPath(ACME, "timesheet");

describe("Settings › Sign-in, role by role", () => {
	it("opens for an owner, with the domains section, and for an admin, without it", async () => {
		const ada = await byCode("ada@acme.com", "owner");
		const alan = await byCode("alan@acme.com", "admin");

		const owners = textOf(await (await open(settings, ada)).text());
		expect(owners).toContain(
			"Anyone in the organisation may sign in with an emailed code, Google or Microsoft.",
		);
		expect(owners).toContain("Domains");

		const response = await open(settings, alan);
		expect(response.status).toBe(200);
		const admins = textOf(await response.text());
		expect(admins).toContain("Anyone in the organisation may sign in");
		expect(admins).not.toContain("Add a domain");
	});

	it("is a 404 for Finance, a manager, a member, a contractor and a stranger, to open and to post", async () => {
		const grace = await byCode("grace@acme.com", "finance");
		const max = await byCode("max@acme.com", "member");
		const mia = await byCode("mia@acme.com", "member");
		const linus = await byCode("linus@acme.com", "member");
		const eve = await byCode("eve@example.com", null);
		await seedTeam(acme.id, "Site", { members: [mia.user.id], managers: [max.user.id] });
		await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
			.bind(linus.user.id)
			.run();

		for (const who of [grace, max, mia, linus, eve]) {
			expect((await open(settings, who)).status, who.user.email).toBe(404);
			expect((await openData(settings, who)).status, who.user.email).toBe(404);
			expect((await choose(who, "microsoft")).status, who.user.email).toBe(404);
			expect(
				(
					await submit(settings, { intent: "add-domain", domain: "acme.com" }, who, {
						byScript: true,
					})
				).status,
				who.user.email,
			).toBe(404);
		}
		expect((await policyOfAcme())?.sign_in_policy).toBe("any");
		expect(await row("select id from organisation_domains")).toBeNull();
	});

	it("is a 404 to the owner of another organisation, who cannot change Acme's policy", async () => {
		const globex = await seedOrganisation("Globex", "globex");
		const grace = await byCode("grace@globex.com", null);
		await seedMembership(globex.id, grace.user.id, "owner");

		expect((await open(settings, grace)).status).toBe(404);
		expect((await choose(grace, "microsoft")).status).toBe(404);
		expect((await policyOfAcme())?.sign_in_policy).toBe("any");
	});
});

describe("changing the policy", () => {
	it("an owner signed in by code may require Microsoft: owners are exempt, so nobody is locked out", async () => {
		const ada = await byCode("ada@acme.com", "owner");

		const response = await choose(ada, "microsoft", ACME_TENANT);
		expect(response.status).toBe(200);
		expect(await policyOfAcme()).toEqual({
			sign_in_policy: "company",
			sign_in_provider: "microsoft",
			sign_in_tenant: ACME_TENANT,
		});
		expect((await open(timesheet, ada)).status).toBe(200);
		expect(textOf(await (await open(settings, ada)).text())).toContain(
			`Company sign-in with Microsoft is required, at Microsoft tenant ID ${ACME_TENANT}.`,
		);
	});

	it("an owner may require Google at no Workspace domain, and the page says why to name one", async () => {
		const ada = await byCode("ada@acme.com", "owner");

		expect((await choose(ada, "google")).status).toBe(200);
		expect(await policyOfAcme()).toEqual({
			sign_in_policy: "company",
			sign_in_provider: "google",
			sign_in_tenant: null,
		});
		expect(textOf(await (await open(settings, ada)).text())).toContain(
			"Name your Workspace domain: until you do, any Google account, a personal one too, meets the policy.",
		);

		expect((await choose(ada, "microsoft")).status).toBe(200);
		expect(textOf(await (await open(settings, ada)).text())).toContain(
			"Name your tenant ID: until you do, a work or school account at any organisation meets the policy.",
		);

		expect((await choose(ada, "microsoft", ACME_TENANT)).status).toBe(200);
		expect(textOf(await (await open(settings, ada)).text())).not.toContain("Name your");
	});

	it("an admin signed in by code cannot require Microsoft: they would lock themselves out", async () => {
		await byCode("ada@acme.com", "owner");
		const alan = await byCode("alan@acme.com", "admin");

		const response = await choose(alan, "microsoft");
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Sign in with Microsoft yourself first");
		expect((await policyOfAcme())?.sign_in_policy).toBe("any");
	});

	it("an admin signed in with Microsoft may require it, at their own tenant and not another", async () => {
		const alan = await byMicrosoft("alan@acme.com", "admin");

		const elsewhere = await choose(alan, "microsoft", OTHER_TENANT);
		expect(elsewhere.status).toBe(400);
		expect(await elsewhere.text()).toContain(`Microsoft tenant ID ${OTHER_TENANT} yourself first`);
		expect((await policyOfAcme())?.sign_in_policy).toBe("any");

		expect((await choose(alan, "microsoft", ACME_TENANT)).status).toBe(200);
		expect((await policyOfAcme())?.sign_in_tenant).toBe(ACME_TENANT);
		expect((await open(timesheet, alan)).status).toBe(200);
	});

	it("a provider this deployment does not offer cannot be required, and a tenant must be one", async () => {
		const ada = await byCode("ada@acme.com", "owner");
		const google = await choose(ada, "google", "not a domain");
		expect(google.status).toBe(400);
		expect(await google.text()).toContain("Enter a Workspace domain such as acme.com");
		const microsoft = await choose(ada, "microsoft", "acme.com");
		expect(microsoft.status).toBe(400);
		expect(await microsoft.text()).toContain("Enter a tenant ID");

		setBinding("GOOGLE_CLIENT_SECRET", undefined);
		const unoffered = await choose(ada, "google");
		expect(unoffered.status).toBe(400);
		expect(await unoffered.text()).toContain(
			"Google sign-in isn't available on this site, so nobody could sign in with it.",
		);
		expect((await policyOfAcme())?.sign_in_policy).toBe("any");
	});

	it("is recorded in the Activity log, before and after", async () => {
		const ada = await byCode("ada@acme.com", "owner");
		expect((await choose(ada, "microsoft", ACME_TENANT)).status).toBe(200);
		expect((await choose(ada, "any")).status).toBe(200);

		const records = await env.DB.prepare(
			"select actor_id, subject_type, subject_id, summary from activity_records where action = 'sign_in_policy.changed' order by id",
		).all<{ actor_id: string; subject_type: string; subject_id: string; summary: string }>();
		expect(
			records.results.map((r) => ({ ...r, summary: JSON.parse(r.summary) as unknown })),
		).toEqual([
			{
				actor_id: ada.user.id,
				subject_type: "organisation",
				subject_id: acme.id,
				summary: {
					before: { signInPolicy: "any", signInTenant: null },
					after: { signInPolicy: "microsoft", signInTenant: ACME_TENANT },
				},
			},
			{
				actor_id: ada.user.id,
				subject_type: "organisation",
				subject_id: acme.id,
				summary: {
					before: { signInPolicy: "microsoft", signInTenant: ACME_TENANT },
					after: { signInPolicy: "any", signInTenant: null },
				},
			},
		]);

		const activity = textOf(await (await open(destinationPath(ACME, "activity"), ada)).text());
		expect(activity).toContain("Microsoft only");
	});

	it("choosing the policy already in force records nothing", async () => {
		const ada = await byCode("ada@acme.com", "owner");
		expect((await choose(ada, "any")).status).toBe(200);
		expect(
			await row("select id from activity_records where action = 'sign_in_policy.changed'"),
		).toBeNull();
	});
});

/** Every route inside the organisation's layout, as a member would ask for it. */
const organisationRoutes = allRoutes.filter(
	(route) => route.ancestors.includes("routes/app/organisation") && !isMoved(route),
);

describe("the gate, when Acme requires Microsoft", () => {
	it("every page of Acme, its data and its forms answer a member signed in by code with 403", async () => {
		const max = await byCode("max@acme.com", "member");
		await requireForAcme("microsoft", ACME_TENANT);

		expect(organisationRoutes.length).toBeGreaterThan(20);
		for (const route of organisationRoutes) {
			expect((await open(route.address, max)).status, route.id).toBe(403);
			expect((await openData(route.address, max)).status, route.id).toBe(403);
			if (route.hasAction) {
				const path = route.isIndex ? `${route.address}?index` : route.address;
				expect((await submit(path, {}, max, { byScript: true })).status, route.id).toBe(403);
			}
		}
	});

	it("the page says who asks, for which sign-in, and offers the one button", async () => {
		const max = await byCode("max@acme.com", "member");
		await requireForAcme("microsoft", ACME_TENANT);

		const response = await open(timesheet, max);
		expect(response.status).toBe(403);
		const text = textOf(await response.text());
		expect(text).toContain("Acme asks you to sign in with Microsoft");
		expect(text).toContain(
			`Acme opens only for people who sign in with your Microsoft account at ${ACME_TENANT}. Sign in with it and you'll come back here.`,
		);
		expect(text).toContain("Sign in with Microsoft");
		expect(text).not.toContain("Sign in with Google");
		expect(text).toContain("Go to your organisations");
	});

	it("a provider this code does not know locks Acme to its owners, who can choose again", async () => {
		const ada = await byCode("ada@acme.com", "owner");
		const alan = await byMicrosoft("alan@acme.com", "admin");
		const max = await byCode("max@acme.com", "member");
		await env.DB.prepare(
			"update organisations set sign_in_policy = 'company', sign_in_provider = 'okta' where id = ?",
		)
			.bind(acme.id)
			.run();

		for (const who of [alan, max]) {
			const response = await open(timesheet, who);
			expect(response.status, who.user.email).toBe(403);
			const text = textOf(await response.text());
			expect(text).toContain("Acme is open only to its owners");
			expect(text).toContain(
				"Acme's sign-in setting names a provider this site doesn't know, so nobody but its owners can open it. Ask an owner of Acme.",
			);
			expect(text).not.toMatch(/Sign in with (Google|Microsoft)/);
			const api = await get(`/organization/list-invitations?organizationId=${acme.id}`, {
				cookie: who.cookie,
				client: who.client,
			});
			expect(api.status, who.user.email).toBe(403);
		}

		const page = await open(settings, ada);
		expect(page.status).toBe(200);
		expect(textOf(await page.text())).toContain("Owners only");
		expect((await choose(ada, "any")).status).toBe(200);
		expect((await open(timesheet, max)).status).toBe(200);
	});

	it("where the deployment does not offer the provider, the page says so and has no button", async () => {
		const max = await byCode("max@acme.com", "member");
		await requireForAcme("google");
		setBinding("GOOGLE_CLIENT_SECRET", undefined);
		const response = await open(timesheet, max);
		const text = textOf(await response.text());
		expect(response.status).toBe(403);
		expect(text).toContain("Google sign-in isn't available here. Ask an owner of Acme.");
		expect(text).not.toContain("Sign in with Google");
	});

	it("each role but owner is held to it: admin, Finance, a manager, a member and a contractor", async () => {
		const ada = await byCode("ada@acme.com", "owner");
		const alan = await byCode("alan@acme.com", "admin");
		const grace = await byCode("grace@acme.com", "finance");
		const max = await byCode("max@acme.com", "member");
		const mia = await byCode("mia@acme.com", "member");
		const linus = await byCode("linus@acme.com", "member");
		await seedTeam(acme.id, "Site", { members: [mia.user.id], managers: [max.user.id] });
		await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
			.bind(linus.user.id)
			.run();
		await requireForAcme("microsoft", ACME_TENANT);

		expect((await open(timesheet, ada)).status).toBe(200);
		expect((await open(settings, ada)).status).toBe(200);
		for (const who of [alan, grace, max, mia, linus]) {
			expect((await open(timesheet, who)).status, who.user.email).toBe(403);
		}
	});

	it("a member signed in with Microsoft at the tenant opens it; at another tenant, or with Google, they do not", async () => {
		const grace = await byMicrosoft("grace@acme.com", "member");
		const eve = await byMicrosoft("eve@acme.com", "member", OTHER_TENANT);
		await requireForAcme("microsoft", ACME_TENANT);

		expect((await open(timesheet, grace)).status).toBe(200);
		expect((await open(timesheet, eve)).status).toBe(403);

		await requireForAcme("google");
		expect((await open(timesheet, grace)).status).toBe(403);
		await requireForAcme("microsoft");
		expect((await open(timesheet, eve)).status).toBe(200);
	});

	it("a policy of Google at a Workspace domain opens for that domain's accounts alone, never a personal Google account", async () => {
		const signedInWithGoogle = async (email: string) => {
			const { cookie } = await signInWith("google", googleClaims(email), {
				client: "203.0.113.200",
			});
			if (!cookie) throw new Error(`Google did not sign ${email} in.`);
			const user = await row<{ id: string; email: string }>(
				"select id, email from users where email = ?",
				email,
			);
			if (!user) throw new Error(`No account for ${email}.`);
			await seedMembership(acme.id, user.id, "member");
			return { cookie, client: "203.0.113.200", user };
		};
		const grace = await signedInWithGoogle("grace@acme.com");
		const mia = await signedInWithGoogle("mia@gmail.com");
		const eve = await signedInWithGoogle("eve@globex.com");
		await requireForAcme("google", "acme.com");

		expect((await open(timesheet, grace)).status).toBe(200);
		expect((await open(timesheet, mia)).status).toBe(403);
		expect((await open(timesheet, eve)).status).toBe(403);
	});

	it("tells a stranger, and a member of another organisation, nothing: a 404", async () => {
		const globex = await seedOrganisation("Globex", "globex");
		const eve = await byCode("eve@example.com", null);
		const grace = await byCode("grace@globex.com", null);
		await seedMembership(globex.id, grace.user.id, "member");
		await requireForAcme("microsoft", ACME_TENANT);

		for (const who of [eve, grace]) {
			const response = await open(timesheet, who);
			expect(response.status, who.user.email).toBe(404);
			expect(await response.text()).not.toContain("asks you to sign in");
		}
		// Grace's own organisation, which requires nothing, opens as before.
		expect((await open(destinationPath("globex", "timesheet"), grace)).status).toBe(200);
	});

	it("holds the organisation API to it too: a member by code is answered 403 COMPANY_SIGN_IN_REQUIRED", async () => {
		const ada = await byCode("ada@acme.com", "owner");
		const max = await byCode("max@acme.com", "member");
		const grace = await byMicrosoft("grace@acme.com", "admin");
		await requireForAcme("microsoft", ACME_TENANT);
		const ask = (who: Person) =>
			get(`/organization/list-invitations?organizationId=${acme.id}`, {
				cookie: who.cookie,
				client: who.client,
			});

		const refused = await ask(max);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ code: COMPANY_SIGN_IN_REQUIRED });
		const left = await post(
			"/organization/leave",
			{ organizationId: acme.id },
			{ cookie: max.cookie, client: max.client },
		);
		expect(left.status).toBe(403);
		expect(await row("select id from memberships where user_id = ?", max.user.id)).not.toBeNull();

		for (const who of [ada, grace]) {
			const answer = await ask(who);
			expect(answer.status, who.user.email).toBe(200);
		}
	});

	it("leaves API tokens and calendar feeds working: neither is a session", async () => {
		const alan = await byCode("alan@acme.com", "admin");
		const scope = organisationScope(env.DB, acme.id);
		const token = await makeToken(scope, alan.user.id, "Test", API_SCOPES);
		const feed = await makeFeed(scope, alan.user.id, { kind: "person", includeEntries: true });
		if (!feed) throw new Error("No feed was made.");
		await requireForAcme("microsoft", ACME_TENANT);

		expect((await open(timesheet, alan)).status).toBe(403);
		const api = await exports.default.fetch(
			new Request(`${ORIGIN}/api/v1/projects`, { headers: { Authorization: `Bearer ${token}` } }),
		);
		expect(api.status).toBe(200);
		const calendar = await exports.default.fetch(new Request(`${ORIGIN}${FEED_PATH}/${feed}.ics`));
		expect(calendar.status).toBe(200);
		expect(await calendar.text()).toContain("BEGIN:VCALENDAR");
	});

	it("still lets the member sign in to Timesifier by code, and open /app", async () => {
		await requireForAcme("microsoft", ACME_TENANT);
		const max = await byCode("max@acme.com", "member");
		const app = await open("/app", max);
		expect([200, 302]).toContain(app.status);
		expect((await open(organisationPath(ACME), max)).status).toBe(403);
	});
});

describe("the policy a row holds", () => {
	it("is open only where it says so, and locked where it names a provider or a word this code does not know", () => {
		const stored = (signInPolicy: string, signInProvider: string | null, signInTenant = null) => ({
			signInPolicy,
			signInProvider,
			signInTenant,
		});
		expect(policyOf(stored("any", null))).toEqual({ kind: "any" });
		expect(policyOf(stored("company", "microsoft"))).toEqual({
			kind: "company",
			provider: "microsoft",
			tenant: null,
		});
		for (const locked of [
			stored("company", "okta"),
			stored("company", null),
			stored("company", ""),
			stored("company", "Microsoft"),
			stored("company", "toString"),
			stored("sso", "google"),
			stored("", null),
		]) {
			const policy = policyOf(locked);
			expect(policy, JSON.stringify(locked)).toEqual({ kind: "locked" });
			for (const signInMethod of ["code", "google", "microsoft", null]) {
				expect(meetsPolicy(policy, { signInMethod, signInTenant: ACME_TENANT })).toBe(false);
			}
		}
	});
});
