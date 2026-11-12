import { exports } from "cloudflare:workers";
import { routes } from "virtual:react-router/server-build";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeNext, signInPath } from "~/routes/auth/paths";
import {
	APP_PATH,
	accountPath,
	destinationPath,
	destinations,
	invitationsPath,
	membersPath,
	NEW_ORGANISATION_PATH,
	organisationPath,
} from "~/shell/destinations";
import { freshDatabase } from "../db/database";
import { createOrganisation } from "../organisations/harness";
import {
	addressFor,
	isMoved,
	isNotFound,
	namesARecord,
	routesAtOrUnder,
	STAND_IN_ORGANISATION,
} from "../routes";
import { captureEmail, type Mailbox, ORIGIN, post, signIn } from "./harness";

// Criterion 6 of card TS-008: every route under /app redirects to sign-in
// without a session. The routes are read from the built route configuration, so
// a route added under /app is requested here without anyone listing it; if it
// is not behind the guard, its test fails.
//
// An organisation's pages are under /app/<slug>. Their addresses here stand on
// the slug `acme`, which is the organisation the signed-in person of these
// tests creates.

const ORGANISATION = STAND_IN_ORGANISATION;
const REPORTS = destinationPath(ORGANISATION, "reports");

const worker = exports.default;

const underApp = routesAtOrUnder(APP_PATH);

const withAction = underApp.filter((route) => route.hasAction);

/** A form a browser would post from our own page: only the session is missing. */
const FORM = {
	method: "POST",
	headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
	body: "scheme=dark",
};

function ask(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
	const headers = new Headers(init.headers);
	if (cookie) headers.set("Cookie", cookie);
	return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }));
}

/** A document request is answered with a redirect to the sign-in page that remembers the address. */
function expectSentToSignIn(response: Response, address: string) {
	expect(response.status).toBe(302);
	expect(response.headers.get("Location")).toBe(signInPath(address));
	expect(response.headers.getSetCookie()).toEqual([]);
}

/**
 * A data request, which is what a move between pages makes, is answered with
 * the framework's encoding of the same redirect, and told to load the page whole.
 */
async function expectDataSentToSignIn(response: Response, address: string) {
	expect(response.status).toBe(202);
	expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
	expect(response.headers.getSetCookie()).toEqual([]);
	const body = await response.text();
	expect(body).toContain(JSON.stringify(signInPath(address)));
	expect(body).toContain('"redirect"');
}

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the list of routes under /app", () => {
	it("is read from the route configuration and holds every destination of the shell", () => {
		const addresses = underApp.map((route) => route.address);
		for (const { id } of destinations) {
			expect(addresses).toContain(destinationPath(ORGANISATION, id));
		}
		expect(addresses).toContain(membersPath(ORGANISATION));
		expect(addresses).toContain(invitationsPath(ORGANISATION));
		expect(addresses).toContain(accountPath(ORGANISATION));
		expect(addresses).toContain(NEW_ORGANISATION_PATH);
		// The two layouts, `/app` itself, the page that creates an organisation,
		// one route for each destination, the members, the invitations and My account.
		expect(underApp.length).toBeGreaterThanOrEqual(destinations.length + 7);
	});

	it("leaves out the pages a person uses without a session", () => {
		const ids = underApp.map((route) => route.id);
		for (const open of ["root", "routes/home", "routes/sign-in"]) {
			expect(Object.keys(routes)).toContain(open);
			expect(ids).not.toContain(open);
		}
	});
});

describe("without a session, every route under /app redirects to sign-in", () => {
	it.each(underApp)("$id: a request for the page $address", async ({ address }) => {
		expectSentToSignIn(await ask(address), address);
	});

	it.each(underApp)("$id: a request for the data of $address", async ({ address }) => {
		await expectDataSentToSignIn(await ask(`${address}.data`), address);
	});

	it("has at least one route with an action to show a POST is covered too", () => {
		expect(withAction.length).toBeGreaterThan(0);
	});

	it.each(withAction)(
		"$id: a form posted to $address, and its action does not run",
		async ({ address }) => {
			expectSentToSignIn(await ask(address, FORM), address);
		},
	);

	it.each(withAction)(
		"$id: a form sent by script to $address, and its action does not run",
		async ({ address }) => {
			await expectDataSentToSignIn(await ask(`${address}.data`, FORM), address);
		},
	);

	it("remembers the query of the page that was asked for", async () => {
		const response = await ask(`${REPORTS}?week=46&team=blue`);
		expect(response.headers.get("Location")).toBe(
			"/sign-in?next=%2Fapp%2Facme%2Freports%3Fweek%3D46%26team%3Dblue",
		);
	});

	it("treats a cookie that names no session as no session", async () => {
		const forged = "__Host-timesifier.session_token=not-a-session.not-a-signature";
		expectSentToSignIn(await ask(APP_PATH, {}, forged), APP_PATH);
	});
});

describe("with a session", () => {
	// `/app` itself shows a page only to a person with several organisations;
	// test/pages/app.test.ts follows where it sends everybody else.
	// An address that has moved answers with a redirect to its new place;
	// test/pages/destinations.test.ts follows it. A resource route, a file to
	// download, is served as that file. The organisation's catch-all answers 404
	// to everyone; test/pages/errors.test.ts follows it. A page of one record,
	// such as a project's own page, is asked for at a record made for it; any
	// other route that names a record, such as a receipt, is followed by its
	// own test.
	const served = underApp.filter(
		(route) =>
			route.address !== APP_PATH && !isMoved(route) && !isNotFound(route) && !namesARecord(route),
	);
	const pages = served.filter((route) => route.hasPage);
	const files = served.filter((route) => !route.hasPage);

	it.each(pages)("$id: $address is served", async (route) => {
		const { cookie } = await signIn(mailbox, "ada@example.com");
		const acme = await createOrganisation(cookie, "Acme");
		expect(acme.slug).toBe(ORGANISATION);
		const address = await addressFor(route, acme.id);

		const page = await ask(address, {}, cookie);
		expect(page.status).toBe(200);
		expect(page.headers.get("Content-Type")).toContain("text/html");
		expect((await ask(`${address}.data`, {}, cookie)).status).toBe(200);
	});

	it.each(files)("$id: $address is served as a file, not a page", async ({ address }) => {
		const { cookie } = await signIn(mailbox, "ada@example.com");
		expect((await createOrganisation(cookie, "Acme")).slug).toBe(ORGANISATION);

		const file = await ask(address, {}, cookie);
		expect(file.status).toBe(200);
		expect(file.headers.get("Content-Type")).not.toContain("text/html");
	});

	it("/app sends a person with one organisation on to it", async () => {
		const { cookie } = await signIn(mailbox, "ada@example.com");
		await createOrganisation(cookie, "Acme");

		const response = await ask(APP_PATH, {}, cookie);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(organisationPath(ORGANISATION));
	});

	it("that has been signed out, the very next request is sent to sign-in", async () => {
		const { cookie } = await signIn(mailbox, "ada@example.com");
		expect((await ask(NEW_ORGANISATION_PATH, {}, cookie)).status).toBe(200);

		expect((await post("/sign-out", {}, { cookie })).status).toBe(200);
		expectSentToSignIn(await ask(NEW_ORGANISATION_PATH, {}, cookie), NEW_ORGANISATION_PATH);
	});

	it("ended from another browser by sign out everywhere, the next move is sent to sign-in", async () => {
		const here = await signIn(mailbox, "ada@example.com");
		const elsewhere = await signIn(mailbox, "ada@example.com");

		expect((await post("/revoke-sessions", {}, { cookie: here.cookie })).status).toBe(200);
		await expectDataSentToSignIn(await ask(`${REPORTS}.data`, {}, elsewhere.cookie), REPORTS);
	});
});

describe("the sign-in page", () => {
	it("is served to a person without a session", async () => {
		const response = await ask("/sign-in");
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/html");
	});

	it("sends a signed-in person on to /app", async () => {
		const { cookie } = await signIn(mailbox, "ada@example.com");
		const response = await ask("/sign-in", {}, cookie);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(APP_PATH);
	});

	it("sends a signed-in person on to the page under /app they were going to", async () => {
		const { cookie } = await signIn(mailbox, "ada@example.com");
		const response = await ask("/sign-in?next=%2Fapp%2Facme%2Freports%3Fweek%3D46", {}, cookie);
		expect(response.headers.get("Location")).toBe("/app/acme/reports?week=46");
	});

	it.each([
		"https://attacker.example/app",
		"//attacker.example/app",
		"/\\attacker.example/app",
		"/sign-in",
		"/",
	])("never sends a signed-in person on to %s", async (next) => {
		const { cookie } = await signIn(mailbox, "ada@example.com");
		const response = await ask(`/sign-in?next=${encodeURIComponent(next)}`, {}, cookie);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(APP_PATH);
	});
});

describe("where a person goes after signing in", () => {
	const INVITATION = "/invitations/01a1c948-14f6-7039-803e-d4cceb52f23a";

	it.each([
		["/app", "/app"],
		["/app/", "/app/"],
		["/app/acme/reports", "/app/acme/reports"],
		["/app/acme/reports?week=46&team=a", "/app/acme/reports?week=46&team=a"],
		// The fragment never reached the server and is not sent back.
		["/app/acme/reports#totals", "/app/acme/reports"],
		// The page of one invitation, by its id. It takes no query, so none is kept.
		[INVITATION, INVITATION],
		[`${INVITATION}?from=email`, INVITATION],
		[`${INVITATION}#join`, INVITATION],
	])("%s is honoured", (next, expected) => {
		expect(safeNext(next)).toBe(expected);
	});

	it.each([
		["nothing", null],
		["an empty value", ""],
		["another origin", "https://attacker.example/app"],
		["another origin without a scheme", "//attacker.example/app"],
		["another origin behind a backslash", "/\\attacker.example/app"],
		["another origin behind a tab", "/\t/attacker.example/app"],
		["a path that is not under /app", "/sign-in"],
		["the home page", "/"],
		["a path that only begins with the same letters", "/application"],
		["a path that climbs out of /app", "/app/../api/auth/sign-out"],
		["a path that climbs out with encoded dots", "/app/%2e%2e/api/auth/sign-out"],
		["a path that climbs out with backslashes", "/app\\..\\api\\auth\\sign-out"],
		["a relative path", "app/reports"],
		["the invitations prefix alone", "/invitations"],
		["the invitations prefix with nothing after it", "/invitations/"],
		["a page below an invitation", `${INVITATION}/accept`],
		["an invitation whose id climbs out", "/invitations/../api/auth/sign-out"],
		["an invitation whose id climbs out with encoded dots", "/invitations/%2e%2e/sign-in"],
		["an invitation whose id holds an encoded slash", "/invitations/a%2Fb"],
		["an invitation whose id holds a backslash", "/invitations/a\\b"],
		["an invitation whose id holds a dot", "/invitations/a.data"],
		["an invitation whose id is too long to be one", `/invitations/${"a".repeat(65)}`],
		["an invitation on another origin", `https://attacker.example${INVITATION}`],
		["an invitation on another origin without a scheme", `//attacker.example${INVITATION}`],
		["an invitation on another origin behind a backslash", `/\\attacker.example${INVITATION}`],
		["a path that only begins like an invitation", "/invitationsx/abc"],
		["a relative invitation", "invitations/abc"],
		["a script", "javascript:alert(1)"],
		["a path with a space before it", " /app"],
	])("%s gives /app", (_case, next) => {
		expect(safeNext(next)).toBe("/app");
	});
});
