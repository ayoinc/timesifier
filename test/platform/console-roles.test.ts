import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLATFORM_PATH, VERIFY_PATH } from "~/platform/paths";
import { signInPath } from "~/routes/auth/paths";

import { captureEmail, type Mailbox, setBinding } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, value } from "../organisations/harness";
import { open, openData, type Person, person, submit } from "../pages/harness";
import { routesAtOrUnder } from "../routes";
import { PLATFORM_OWNER, platformOwner, stepUp } from "./harness";

// Who opens the platform console (TS-099, docs/security.md, "The platform
// console"). Every route under /platform is read from the route configuration,
// so a page added to the console is asked for here without anyone listing it,
// by six people:
//
// - a platform owner whose session has proved their inbox: every page;
// - a platform owner whose session has not: only the page that asks for the
//   code; every other page sends them to it;
// - the owner, an admin and a member of an organisation: the same 404 as an
//   address that holds nothing, whatever they ask for and whatever they post;
// - a stranger, without a session: sent to sign in, as every signed-in page does.

const underPlatform = routesAtOrUnder(PLATFORM_PATH);
/** One request per address: the layouts and the index share `/platform`. */
const addresses = [...new Set(underPlatform.map(({ address }) => address))];
const withAction = underPlatform.filter((route) => route.hasAction);

let mailbox: Mailbox;
let organisationId: string;
let accountId: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	setBinding("PLATFORM_OWNERS", PLATFORM_OWNER);
	const ada = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(ada.cookie, "Acme");
	organisationId = acme.id;
	accountId = ada.user.id;
});

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The address with a real record where it names one: the console's pages of
 * one organisation and one account answer 404 for an id that names nothing,
 * and the test must see the page. The support view needs a grant in force; it
 * is given one where the test asks for the page.
 */
function real(address: string): string {
	return address
		.replace(/\/organisations\/x(?=\/|$)/, `/organisations/${organisationId}`)
		.replace(/\/accounts\/x(?=\/|$)/, `/accounts/${accountId}`);
}

async function grantSupport() {
	const now = Date.now();
	await env.DB.prepare(
		"insert into support_grants (id, organisation_id, granted_by, expires_at, created_at, updated_at) values ('g-1', ?1, ?2, ?3, ?4, ?4)",
	)
		.bind(organisationId, accountId, now + 86_400_000, now)
		.run();
}

/** The status a stepped-up platform owner is answered at `address`. */
function ownerStatus(address: string): number {
	// The catch-all answers every address under /platform that holds no page.
	return address === `${PLATFORM_PATH}/x` ? 404 : 200;
}

async function organisationMember(role: Role): Promise<Person> {
	const who = await person(mailbox, `${role}@example.com`);
	if (role !== "owner") await seedMembership(organisationId, who.user.id, role);
	else await createOrganisation(who.cookie, "Globex");
	return who;
}

describe("the console's routes", () => {
	it("are read from the route configuration and hold every page of the console", () => {
		const ids = underPlatform.map(({ id }) => id);
		for (const page of [
			"routes/platform/layout",
			"routes/platform/verify",
			"routes/platform/console",
			"routes/platform/health",
			"routes/platform/organisations",
			"routes/platform/organisation",
			"routes/platform/support",
			"routes/platform/accounts",
			"routes/platform/account",
			"routes/platform/mail",
			"routes/platform/log",
			"routes/platform/brand",
			"routes/platform/not-found",
		]) {
			expect(ids).toContain(page);
		}
	});

	it("are each inside the owners' layout, and all but the code's inside the step-up's", () => {
		for (const route of underPlatform) {
			if (route.id === "routes/platform/layout") continue;
			expect(route.ancestors, route.id).toContain("routes/platform/layout");
			if (route.id === "routes/platform/verify" || route.id === "routes/platform/console") continue;
			expect(route.ancestors, route.id).toContain("routes/platform/console");
		}
	});

	it("the support view is read-only: it has no action", () => {
		const support = underPlatform.find(({ id }) => id === "routes/platform/support");
		expect(support?.hasAction).toBe(false);
	});
});

describe("a platform owner who has stepped up", () => {
	it.each(addresses)("opens %s", async (address) => {
		const owner = await platformOwner(mailbox);
		await grantSupport();
		const response = await open(real(address), owner);
		// The page that asks for the code sends a session that has proved it on.
		if (address === VERIFY_PATH) {
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(PLATFORM_PATH);
			return;
		}
		expect(response.status).toBe(ownerStatus(address));
	});

	it("is answered 404 at an organisation or an account that does not exist", async () => {
		const owner = await platformOwner(mailbox);
		for (const address of [
			`${PLATFORM_PATH}/organisations/nobody`,
			`${PLATFORM_PATH}/organisations/nobody/support`,
			`${PLATFORM_PATH}/accounts/nobody`,
		]) {
			expect((await open(address, owner)).status, address).toBe(404);
		}
	});

	it("is answered 404 at the support view of an organisation that has granted nothing", async () => {
		const owner = await platformOwner(mailbox);
		expect(
			(await open(`${PLATFORM_PATH}/organisations/${organisationId}/support`, owner)).status,
		).toBe(404);
	});

	it("is not given the organisation's own pages by being a platform owner", async () => {
		const owner = await platformOwner(mailbox);
		expect((await open("/app/acme/timesheet", owner)).status).toBe(404);
	});
});

describe("a platform owner who has not stepped up", () => {
	it.each(addresses)("is sent to the code's page from %s", async (address) => {
		const owner = await platformOwner(mailbox, { steppedUp: false });
		const response = await open(real(address), owner);
		if (address === VERIFY_PATH) {
			expect(response.status).toBe(200);
			return;
		}
		expect(response.status).toBe(302);
		const next = address === PLATFORM_PATH ? "" : `?next=${encodeURIComponent(real(address))}`;
		expect(response.headers.get("Location")).toBe(`${VERIFY_PATH}${next}`);
	});

	it.each(withAction.filter(({ id }) => id !== "routes/platform/verify"))(
		"$id: a form posted to $address does not run",
		async ({ address }) => {
			const owner = await platformOwner(mailbox, { steppedUp: false });
			const before = await value("select count(*) from platform_events");
			const response = await submit(real(address), { intent: "close", reason: "Testing" }, owner);
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toMatch(new RegExp(`^${VERIFY_PATH}`));
			expect(await value("select count(*) from platform_events")).toBe(before);
		},
	);

	it("is not stepped up by a step-up that has run out", async () => {
		const owner = await platformOwner(mailbox, { steppedUp: false });
		await stepUp(owner, new Date(Date.now() - 13 * 3_600_000));
		expect((await open(`${PLATFORM_PATH}/accounts`, owner)).status).toBe(302);
	});
});

describe.each(["owner", "admin", "member"] as const)("an organisation's %s", (role) => {
	it.each(addresses)(
		"is answered 404 at %s, as at an address that holds nothing",
		async (address) => {
			const who = await organisationMember(role);
			await grantSupport();
			const page = await open(real(address), who);
			const nothing = await open(`${PLATFORM_PATH}-nothing-here`, who);
			expect(page.status).toBe(404);
			expect(nothing.status).toBe(404);
			expect((await openData(real(address), who)).status).toBe(404);
		},
	);

	it.each(withAction)(
		"$id: a form posted to $address is 404 and does not run",
		async ({ address }) => {
			const who = await organisationMember(role);
			const forms: Record<string, string>[] = [
				{ intent: "send" },
				{ intent: "close", reason: "Taken over" },
				{ intent: "delete", reason: "Taken over", confirm: "ada@example.com" },
			];
			for (const fields of forms) {
				for (const byScript of [false, true]) {
					expect((await submit(real(address), fields, who, { byScript })).status).toBe(404);
				}
			}
			expect(await value("select count(*) from platform_events")).toBe(0);
			expect(await value("select count(*) from platform_step_ups")).toBe(0);
			expect(await value("select closed_at from users where id = ?", accountId)).toBeNull();
			expect(mailbox.sent().filter(({ subject }) => subject.includes("console"))).toEqual([]);
		},
	);

	it("is answered 404 even with a step-up row of their own", async () => {
		const who = await organisationMember(role);
		await stepUp(who);
		expect((await open(`${PLATFORM_PATH}/accounts`, who)).status).toBe(404);
	});
});

describe("a stranger, without a session", () => {
	it.each(addresses)("is sent to sign in from %s", async (address) => {
		const response = await open(real(address));
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(signInPath(real(address)));
	});

	it.each(withAction)("$id: a form posted to $address does not run", async ({ address }) => {
		const response = await submit(real(address), { intent: "close", reason: "Taken over" });
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(signInPath(real(address)));
		expect(await value("select count(*) from platform_events")).toBe(0);
	});
});

describe("with no platform owners set", () => {
	it("the console is closed to everybody, the address that was an owner's included", async () => {
		setBinding("PLATFORM_OWNERS", "");
		const former = await person(mailbox, PLATFORM_OWNER);
		await stepUp(former);
		for (const address of addresses) {
			expect((await open(real(address), former)).status, address).toBe(404);
		}
	});
});
