import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOLVER } from "~/organisations/dns.server";
import {
	FRESH_CODE_MINUTES,
	provesAddress,
	UNVERIFY_AFTER_DAYS,
	WARN_AFTER_DAYS,
} from "~/organisations/domains.server";
import { planStanding, seatForOneMore } from "~/plans/plans.server";
import { organisationPath, signInSettingsPath } from "~/shell/destinations";
import worker from "../../workers/app";
import { DAILY } from "../../workers/scheduled";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { open, type Person, person, submit, textOf } from "../pages/harness";
import {
	ROOM_FOR_EVERYONE,
	type Role,
	row,
	seedMembership,
	seedOrganisation,
	seedTeam,
	setSeats,
} from "./harness";

// The seat checks, as they are, unless a test reads them stale.
vi.mock("~/plans/plans.server", { spy: true });

// TS-104 slice 104c: an organisation's owners add a domain, prove it is theirs
// with a TXT record, and may let people whose verified address is at it join
// on their own. The record is looked up over DNS over HTTPS
// (app/organisations/dns.server.ts), stubbed here: no test reaches a resolver.

const DAY = 24 * 60 * 60 * 1000;

let mailbox: Mailbox;
let acme: { id: string };
let ada: Person;

/** The TXT records each name holds, as the stub resolver answers; "fail" for a lookup that fails. */
let dns: Map<string, string[] | "fail">;
let lookups: string[];

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	acme = await seedOrganisation("Acme", "acme");
	await setSeats(acme.id, ROOM_FOR_EVERYONE);
	ada = await member("ada@acme.com", "owner");
	dns = new Map();
	lookups = [];
	const real = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (`${url.origin}${url.pathname}` !== RESOLVER) return real(input, init);
		const name = url.searchParams.get("name") ?? "";
		lookups.push(name);
		const records = dns.get(name);
		if (records === "fail") return new Response("Service Unavailable", { status: 503 });
		return Response.json(
			records === undefined
				? { Status: 3 }
				: { Status: 0, Answer: records.map((text) => ({ type: 16, data: `"${text}"` })) },
		);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	// Back to the real seat checks, whatever a test queued and did not use.
	vi.mocked(planStanding).mockReset();
	vi.mocked(seatForOneMore).mockReset();
});

async function member(email: string, role: Role | null, organisationId = acme.id): Promise<Person> {
	const who = await person(mailbox, email);
	if (role) await seedMembership(organisationId, who.user.id, role);
	return who;
}

/** Posts a domain form of Settings › Sign-in as `who`, by script. */
function act(who: Person, fields: Record<string, string>, slug = "acme") {
	return submit(signInSettingsPath(slug), fields, who, { byScript: true });
}

type Domain = {
	id: string;
	organisation_id: string;
	domain: string;
	token: string;
	verified_at: number | null;
	last_seen_at: number | null;
	self_join: number;
};

function domainRow(domain: string, organisationId = acme.id) {
	return row<Domain>(
		"select * from organisation_domains where domain = ? and organisation_id = ?",
		domain,
		organisationId,
	);
}

/** Adds `domain` to the organisation as `who`, and returns its row. */
async function add(who: Person, domain: string, slug = "acme", organisationId = acme.id) {
	const response = await act(who, { intent: "add-domain", domain }, slug);
	expect(response.status).toBe(200);
	const added = await domainRow(domain.toLowerCase(), organisationId);
	if (!added) throw new Error(`${domain} was not added.`);
	return added;
}

/** Puts the record that proves `row` into the stub DNS. */
function publish(added: Pick<Domain, "domain" | "token">) {
	dns.set(`_timesifier.${added.domain}`, ["v=spf1 -all", `timesifier-verification=${added.token}`]);
}

/** Adds and verifies acme.com for Acme through the page, with joining on unless said. */
async function verifiedAcme({ selfJoin = true } = {}) {
	const added = await add(ada, "acme.com");
	publish(added);
	expect((await act(ada, { intent: "check-domain", domainId: added.id })).status).toBe(200);
	if (selfJoin) {
		const on = await act(ada, { intent: "self-join", domainId: added.id, selfJoin: "on" });
		expect(on.status).toBe(200);
	}
	return added;
}

/** Runs the daily Cron Trigger at `at`. */
async function daily(at: number) {
	const controller = createScheduledController({ scheduledTime: at, cron: DAILY });
	const context = createExecutionContext();
	await worker.scheduled(controller, env, context);
	await waitOnExecutionContext(context);
}

const missingMail = () =>
	mailbox
		.sent()
		.filter((m) => m.subject === "A verified domain's DNS record is missing on Timesifier");

describe("adding and verifying a domain", () => {
	it("shows the owner the TXT record to add, and Check finds it and verifies the domain", async () => {
		expect((await act(ada, { intent: "add-domain", domain: "  @ACME.com. " })).status).toBe(200);
		const added = await domainRow("acme.com");
		if (!added) throw new Error("acme.com was not added.");
		expect(added).toMatchObject({ domain: "acme.com", verified_at: null, self_join: 0 });
		expect(added.token).toMatch(/^[0-9a-f]{32}$/);

		const page = textOf(await (await open(signInSettingsPath("acme"), ada)).text());
		expect(page).toContain("_timesifier.acme.com");
		expect(page).toContain(`timesifier-verification=${added.token}`);

		const early = await act(ada, { intent: "check-domain", domainId: added.id });
		expect(early.status).toBe(400);
		expect(await early.text()).toContain("The TXT record isn't at _timesifier.acme.com yet.");
		expect((await domainRow("acme.com"))?.verified_at).toBeNull();

		publish(added);
		const checked = await act(ada, { intent: "check-domain", domainId: added.id });
		expect(checked.status).toBe(200);
		expect(await checked.text()).toContain("acme.com is verified.");
		expect(lookups).toContain("_timesifier.acme.com");
		const verified = await domainRow("acme.com");
		expect(verified?.verified_at).not.toBeNull();
		expect(verified?.last_seen_at).toBe(verified?.verified_at);

		const actions = await env.DB.prepare(
			"select action, source from activity_records where action like 'organisation_domain.%' order by id",
		).all<{ action: string; source: string }>();
		expect(actions.results).toEqual([
			{ action: "organisation_domain.added", source: "web" },
			{ action: "organisation_domain.verified", source: "web" },
		]);
	});

	it("a record with another token, or a lookup that fails, verifies nothing", async () => {
		const added = await add(ada, "acme.com");
		dns.set("_timesifier.acme.com", ["timesifier-verification=someone-elses-token"]);
		expect((await act(ada, { intent: "check-domain", domainId: added.id })).status).toBe(400);

		dns.set("_timesifier.acme.com", "fail");
		const failed = await act(ada, { intent: "check-domain", domainId: added.id });
		expect(failed.status).toBe(400);
		expect(await failed.text()).toContain("The DNS lookup didn't answer.");
		expect((await domainRow("acme.com"))?.verified_at).toBeNull();
	});

	it("refuses a free mail domain, and a name that is not a domain", async () => {
		for (const domain of ["gmail.com", "outlook.com", "hotmail.com", "proton.me", "icloud.com"]) {
			const refused = await act(ada, { intent: "add-domain", domain });
			expect(refused.status, domain).toBe(400);
			expect(await refused.text(), domain).toContain("is a free mail domain");
		}
		for (const domain of ["acme", "not a domain", "-acme.com", "acme..com"]) {
			const refused = await act(ada, { intent: "add-domain", domain });
			expect(refused.status, domain).toBe(400);
			expect(await refused.text(), domain).toContain("Enter a domain such as acme.com.");
		}
		expect(await row("select id from organisation_domains")).toBeNull();
	});

	it("adds a domain once to an organisation", async () => {
		await add(ada, "acme.com");
		const again = await act(ada, { intent: "add-domain", domain: "acme.com" });
		expect(again.status).toBe(400);
		expect(await again.text()).toContain("acme.com is already one of your domains.");
	});

	it("a domain another organisation has verified cannot be verified for a second: no squatting", async () => {
		await verifiedAcme();
		const acmes = await domainRow("acme.com");
		const globex = await seedOrganisation("Globex", "globex");
		const grace = await member("grace@globex.com", "owner", globex.id);

		// Globex may write the name down, but not prove it: it is Acme's.
		const theirs = await add(grace, "acme.com", "globex", globex.id);
		publish(theirs);
		const refused = await act(grace, { intent: "check-domain", domainId: theirs.id }, "globex");
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain("Another organisation has already verified acme.com");
		expect((await domainRow("acme.com", globex.id))?.verified_at).toBeNull();
		expect((await domainRow("acme.com"))?.verified_at).toBe(acmes?.verified_at);

		// Nor does the daily re-check verify it behind Acme's back.
		await daily(Date.now() + DAY);
		expect((await domainRow("acme.com", globex.id))?.verified_at).toBeNull();
		const eve = await member("eve@acme.com", null);
		const app = textOf(await (await open("/app", eve)).text());
		expect(app).toContain("Join Acme");
		expect(app).not.toContain("Join Globex");
	});

	it("removing a domain ends joining by it", async () => {
		const added = await verifiedAcme();
		const removed = await act(ada, { intent: "remove-domain", domainId: added.id });
		expect(removed.status).toBe(200);
		expect(await domainRow("acme.com")).toBeNull();
		const eve = await member("eve@acme.com", null);
		expect((await open("/app", eve)).status).toBe(302);
	});
});

describe("the daily re-check", () => {
	it("failed lookups count toward unverifying: the owners are told after 7 days, and it is unverified after 14", async () => {
		const added = await verifiedAcme();
		const verifiedAt = (await domainRow("acme.com"))?.verified_at ?? 0;

		dns.set("_timesifier.acme.com", "fail");
		await daily(verifiedAt + 3 * DAY);
		expect(await domainRow("acme.com")).toMatchObject({
			verified_at: verifiedAt,
			last_seen_at: verifiedAt,
		});
		await daily(verifiedAt + WARN_AFTER_DAYS * DAY);
		expect(missingMail()).toHaveLength(1);
		await daily(verifiedAt + UNVERIFY_AFTER_DAYS * DAY);
		expect((await domainRow("acme.com"))?.verified_at).toBeNull();

		// The resolver answers again and the record is there: verified once more, and seen now.
		publish(added);
		const back = verifiedAt + (UNVERIFY_AFTER_DAYS + 1) * DAY;
		await daily(back);
		expect(await domainRow("acme.com")).toMatchObject({ verified_at: back, last_seen_at: back });
	});

	it("a verified domain whose record was last seen more than 48 hours ago is not joined by", async () => {
		await verifiedAcme();
		const eve = await member("eve@acme.com", null);
		expect(textOf(await (await open("/app", eve)).text())).toContain("Join Acme");

		await env.DB.prepare(
			"update organisation_domains set last_seen_at = ? where domain = 'acme.com'",
		)
			.bind(Date.now() - 49 * 60 * 60 * 1000)
			.run();
		expect((await open("/app", eve)).status).toBe(302);
		const refused = await submit("/app?index", { intent: "join", organisationId: acme.id }, eve, {
			byScript: true,
		});
		expect(refused.status).toBe(404);
		expect(await row("select id from memberships where user_id = ?", eve.user.id)).toBeNull();
	});

	it(`emails the owners once after ${WARN_AFTER_DAYS} days without the record, and unverifies after ${UNVERIFY_AFTER_DAYS}`, async () => {
		const added = await verifiedAcme();
		const bob = await member("bob@acme.com", "owner");
		await member("alan@acme.com", "admin");
		const seen = (await domainRow("acme.com"))?.last_seen_at ?? 0;
		dns.delete(`_timesifier.${added.domain}`);

		await daily(seen + (WARN_AFTER_DAYS - 1) * DAY);
		expect(missingMail()).toEqual([]);

		for (let day = WARN_AFTER_DAYS; day < UNVERIFY_AFTER_DAYS; day += 1) {
			await daily(seen + day * DAY);
		}
		const told = missingMail();
		expect(told.map((m) => m.to).sort()).toEqual([ada.user.email, bob.user.email].sort());
		expect(told[0]?.text).toContain("_timesifier.acme.com");
		expect((await domainRow("acme.com"))?.verified_at).not.toBeNull();

		await daily(seen + UNVERIFY_AFTER_DAYS * DAY);
		expect((await domainRow("acme.com"))?.verified_at).toBeNull();
		expect(missingMail()).toHaveLength(2);
		expect(
			await row(
				"select actor_id, source from activity_records where action = 'organisation_domain.unverified'",
			),
		).toEqual({ actor_id: null, source: "system" });

		// Nobody joins by it now.
		const eve = await member("eve@acme.com", null);
		expect((await open("/app", eve)).status).toBe(302);

		// The record put back verifies it again, by the same re-check.
		publish(added);
		await daily(seen + (UNVERIFY_AFTER_DAYS + 1) * DAY);
		expect((await domainRow("acme.com"))?.verified_at).toBe(seen + (UNVERIFY_AFTER_DAYS + 1) * DAY);
	});

	it("a record that goes missing a second time is told of again", async () => {
		const added = await verifiedAcme();
		const seen = (await domainRow("acme.com"))?.last_seen_at ?? 0;
		dns.delete("_timesifier.acme.com");
		await daily(seen + WARN_AFTER_DAYS * DAY);
		expect(missingMail()).toHaveLength(1);

		publish(added);
		await daily(seen + 9 * DAY);
		dns.delete("_timesifier.acme.com");
		await daily(seen + (9 + WARN_AFTER_DAYS) * DAY);
		expect(missingMail()).toHaveLength(2);
		expect((await domainRow("acme.com"))?.verified_at).not.toBeNull();
	});
});

describe("joining by a verified domain", () => {
	it("a person whose verified address is at the domain sees Join Acme and joins as a member", async () => {
		await verifiedAcme();
		const eve = await member("eve@acme.com", null);

		const app = await open("/app", eve);
		expect(app.status).toBe(200);
		expect(textOf(await app.text())).toContain("Join Acme");

		const joined = await submit("/app?index", { intent: "join", organisationId: acme.id }, eve);
		expect(joined.status).toBe(302);
		expect(joined.headers.get("Location")).toBe(organisationPath("acme"));
		expect(
			await row(
				"select role from memberships where user_id = ? and organisation_id = ?",
				eve.user.id,
				acme.id,
			),
		).toEqual({ role: "member" });
		expect(
			await row(
				"select actor_id, owner_id from activity_records where action = 'membership.joined'",
			),
		).toEqual({ actor_id: eve.user.id, owner_id: eve.user.id });

		// Joined, Acme is no longer offered, and /app goes straight to it.
		expect((await open("/app", eve)).headers.get("Location")).toBe(organisationPath("acme"));
	});

	it("nobody joins while joining is off, by an unverified address, or at another domain", async () => {
		const added = await verifiedAcme({ selfJoin: false });
		const eve = await member("eve@acme.com", null);
		const sub = await member("sam@eu.acme.com", null);
		const unverified = await member("una@acme.com", null);
		await env.DB.prepare("update users set email_verified = 0 where id = ?")
			.bind(unverified.user.id)
			.run();

		const refused = await submit("/app?index", { intent: "join", organisationId: acme.id }, eve, {
			byScript: true,
		});
		expect(refused.status).toBe(404);

		await act(ada, { intent: "self-join", domainId: added.id, selfJoin: "on" });
		for (const who of [sub, unverified]) {
			const answer = await submit("/app?index", { intent: "join", organisationId: acme.id }, who, {
				byScript: true,
			});
			expect(answer.status, who.user.email).toBe(404);
			expect(await row("select id from memberships where user_id = ?", who.user.id)).toBeNull();
		}
	});

	it("an organisation with no free seat is not joined, and the person is told it is full", async () => {
		await verifiedAcme();
		await setSeats(acme.id, 1);
		const eve = await member("eve@acme.com", null);

		const full = await submit("/app?index", { intent: "join", organisationId: acme.id }, eve, {
			byScript: true,
		});
		expect(full.status).toBe(409);
		expect(await full.text()).toContain("Acme has no free seat, so you can't join yet.");
		expect(await row("select id from memberships where user_id = ?", eve.user.id)).toBeNull();
	});

	it("two people joining for the last seat: the second, whose seat check read before the first joined, is told it is full", async () => {
		await verifiedAcme();
		const eve = await member("eve@acme.com", null);
		const sam = await member("sam@acme.com", null);
		// Ada holds one seat; one is left.
		await setSeats(acme.id, 2);
		// Sam's request read the seats while one was still free, and is overtaken by Eve's.
		const before = await planStanding(acme.id, new Date());
		const join = (who: Person) =>
			submit("/app?index", { intent: "join", organisationId: acme.id }, who, { byScript: true });
		expect((await join(eve)).status).toBe(202);
		vi.mocked(planStanding).mockResolvedValueOnce(before);
		vi.mocked(seatForOneMore).mockResolvedValueOnce(true);

		const second = await join(sam);

		expect(second.status).toBe(409);
		expect(await second.text()).toContain("Acme has no free seat, so you can't join yet.");
		expect(
			await row("select count(*) as n from memberships where organisation_id = ?", acme.id),
		).toEqual({ n: 2 });
		expect(
			await row("select count(*) as n from activity_records where action = 'membership.joined'"),
		).toEqual({ n: 1 });
	});

	it("a person removed from Acme is not offered Join, and is refused, until Acme invites them again", async () => {
		await verifiedAcme();
		const eve = await member("eve@acme.com", null);
		const join = () =>
			submit("/app?index", { intent: "join", organisationId: acme.id }, eve, { byScript: true });
		// By script, a join that redirects answers 202.
		expect((await join()).status).toBe(202);

		const membership = await row<{ id: string }>(
			"select id from memberships where user_id = ? and organisation_id = ?",
			eve.user.id,
			acme.id,
		);
		const removed = await submit(
			"/app/acme/team/members",
			{ intent: "remove", memberId: membership?.id ?? "" },
			ada,
			{ byScript: true },
		);
		expect(removed.status).toBe(200);
		// Who removed whom, and when.
		expect(
			await row(
				"select user_id, removed_by from membership_removals where organisation_id = ?",
				acme.id,
			),
		).toEqual({ user_id: eve.user.id, removed_by: ada.user.id });

		expect(textOf(await (await open("/app", eve)).text())).not.toContain("Join Acme");
		const refused = await join();
		expect(refused.status).toBe(404);
		expect(await row("select id from memberships where user_id = ?", eve.user.id)).toBeNull();

		// Invited again after the removal, Eve may join by the domain once more.
		const invited = await submit(
			"/app/acme/team/invitations",
			{ intent: "invite", email: "eve@acme.com", role: "member" },
			ada,
			{ byScript: true },
		);
		expect(invited.status).toBe(200);
		expect(textOf(await (await open("/app", eve)).text())).toContain("Join Acme");
		expect((await join()).status).toBe(202);
	});

	it(`a code session older than ${FRESH_CODE_MINUTES} minutes proves nothing now; signing in again does`, async () => {
		await verifiedAcme();
		const stale = await member("eve@acme.com", null);
		await env.DB.prepare("update sessions set created_at = ? where user_id = ?")
			.bind(Date.now() - (FRESH_CODE_MINUTES + 1) * 60 * 1000, stale.user.id)
			.run();

		expect(textOf(await (await open("/app", stale)).text())).not.toContain("Join Acme");
		const refused = await submit("/app?index", { intent: "join", organisationId: acme.id }, stale, {
			byScript: true,
		});
		expect(refused.status).toBe(404);
		expect(await refused.text()).toContain("Sign in again with a code sent to your address");
		expect(await row("select id from memberships where user_id = ?", stale.user.id)).toBeNull();

		const fresh = await member("eve@acme.com", null);
		expect(textOf(await (await open("/app", fresh)).text())).toContain("Join Acme");
		const joined = await submit("/app?index", { intent: "join", organisationId: acme.id }, fresh);
		expect(joined.status).toBe(302);
	});

	it("proof of the address: a code within 15 minutes, Google at the address's own Workspace domain, or Microsoft", () => {
		const now = new Date("2026-11-23T12:00:00Z");
		const ago = (minutes: number) => new Date(now.getTime() - minutes * 60 * 1000);
		expect(provesAddress({ signInMethod: "code", createdAt: ago(15) }, "acme.com", now)).toBe(true);
		expect(provesAddress({ signInMethod: "code", createdAt: ago(16) }, "acme.com", now)).toBe(
			false,
		);
		const google = { signInMethod: "google", createdAt: ago(600) };
		expect(provesAddress({ ...google, signInTenant: "acme.com" }, "acme.com", now)).toBe(true);
		expect(provesAddress({ ...google, signInTenant: "globex.com" }, "acme.com", now)).toBe(false);
		expect(provesAddress({ ...google, signInTenant: null }, "acme.com", now)).toBe(false);
		const microsoft = {
			signInMethod: "microsoft",
			signInTenant: "0b9c7d5e-1f2a-4b3c-8d4e-5f6a7b8c9d0e",
		};
		expect(provesAddress({ ...microsoft, createdAt: ago(600) }, "acme.com", now)).toBe(true);
		// A session made before sign-in methods were recorded proves nothing.
		expect(provesAddress({ signInMethod: null, createdAt: ago(1) }, "acme.com", now)).toBe(false);
	});
});

describe("the domain actions, role by role", () => {
	it("are the owners' alone: an admin, Finance, a manager, a member, a contractor and a stranger get a 404", async () => {
		const added = await add(ada, "acme.com");
		publish(added);
		const alan = await member("alan@acme.com", "admin");
		const grace = await member("grace@acme.com", "finance");
		const max = await member("max@acme.com", "member");
		const mia = await member("mia@acme.com", "member");
		const linus = await member("linus@acme.com", "member");
		const eve = await member("eve@example.com", null);
		await seedTeam(acme.id, "Site", { members: [mia.user.id], managers: [max.user.id] });
		await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
			.bind(linus.user.id)
			.run();

		// An admin sees Settings › Sign-in, but not the domains.
		const page = textOf(await (await open(signInSettingsPath("acme"), alan)).text());
		expect(page).not.toContain("acme.com");
		for (const who of [alan, grace, max, mia, linus, eve]) {
			for (const fields of <Record<string, string>[]>[
				{ intent: "add-domain", domain: "acme.org" },
				{ intent: "check-domain", domainId: added.id },
				{ intent: "self-join", domainId: added.id, selfJoin: "on" },
				{ intent: "remove-domain", domainId: added.id },
			]) {
				expect((await act(who, fields)).status, `${who.user.email} ${fields.intent}`).toBe(404);
			}
		}
		expect(await row("select domain, verified_at, self_join from organisation_domains")).toEqual({
			domain: "acme.com",
			verified_at: null,
			self_join: 0,
		});
	});

	it("an owner of another organisation cannot reach Acme's domains through their own", async () => {
		const added = await add(ada, "acme.com");
		publish(added);
		const globex = await seedOrganisation("Globex", "globex");
		const grace = await member("grace@globex.com", "owner", globex.id);

		for (const fields of <Record<string, string>[]>[
			{ intent: "check-domain", domainId: added.id },
			{ intent: "self-join", domainId: added.id, selfJoin: "on" },
			{ intent: "remove-domain", domainId: added.id },
		]) {
			expect((await act(grace, fields, "globex")).status, fields.intent).toBe(404);
			expect((await act(grace, fields)).status, fields.intent).toBe(404);
		}
		expect(await domainRow("acme.com")).toMatchObject({ verified_at: null, self_join: 0 });
	});
});
