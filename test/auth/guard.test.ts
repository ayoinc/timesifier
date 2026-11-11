import { exports } from "cloudflare:workers";
import { routes } from "virtual:react-router/server-build";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeNext, signInPath } from "~/routes/auth/paths";
import { APP_PATH, destinations } from "~/shell/destinations";
import { freshDatabase } from "../db/database";
import { captureEmail, type Mailbox, ORIGIN, post, signIn } from "./harness";

// Criterion 6 of card TS-008: every route under /app redirects to sign-in
// without a session. The routes are read from the built route configuration, so
// a route added under /app is requested here without anyone listing it; if it
// is not behind the guard, its test fails.

const worker = exports.default;

type RouteUnderTest = {
	id: string;
	/** The route's full address, with a stand-in for each parameter. */
	address: string;
	hasAction: boolean;
};

/** A route's address: its own path after those of the routes it is nested in. */
function addressOf(id: string | undefined): string {
	const route = id === undefined ? undefined : routes[id];
	if (!route) return "";
	const own = (route.path ?? "")
		.split("/")
		.filter(Boolean)
		// `:id`, `:id?` and `*` each stand for something a person would have typed.
		.map((segment) => (segment.startsWith(":") || segment === "*" ? "x" : segment));
	return [addressOf(route.parentId), ...own].filter(Boolean).join("/");
}

/** Every route whose address is /app or below it, wherever it sits in the route tree. */
const underApp: RouteUnderTest[] = Object.values(routes)
	.filter((route) => route !== undefined)
	.map((route) => ({
		id: route.id,
		address: `/${addressOf(route.id)}`,
		hasAction: route.module.action !== undefined,
	}))
	.filter(({ address }) => address === APP_PATH || address.startsWith(`${APP_PATH}/`));

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
		for (const destination of destinations) expect(addresses).toContain(destination.path);
		// The layout, and one route for each destination.
		expect(underApp.length).toBeGreaterThanOrEqual(destinations.length + 1);
	});

	it("leaves out the pages a person uses without a session", () => {
		const ids = underApp.map((route) => route.id);
		for (const open of ["root", "routes/home", "routes/sign-in", "routes/sign-up"]) {
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
		const response = await ask(`${APP_PATH}/reports?week=46&team=blue`);
		expect(response.headers.get("Location")).toBe(
			"/sign-in?next=%2Fapp%2Freports%3Fweek%3D46%26team%3Dblue",
		);
	});

	it("treats a cookie that names no session as no session", async () => {
		const forged = "__Host-timesifier.session_token=not-a-session.not-a-signature";
		expectSentToSignIn(await ask(APP_PATH, {}, forged), APP_PATH);
	});
});

describe("with a session", () => {
	it.each(underApp)("$id: $address is served", async ({ address }) => {
		const { cookie } = await signIn(mailbox, "ada@example.com");

		const page = await ask(address, {}, cookie);
		expect(page.status).toBe(200);
		expect(page.headers.get("Content-Type")).toContain("text/html");
		expect((await ask(`${address}.data`, {}, cookie)).status).toBe(200);
	});

	it("that has been signed out, the very next request is sent to sign-in", async () => {
		const { cookie } = await signIn(mailbox, "ada@example.com");
		expect((await ask(APP_PATH, {}, cookie)).status).toBe(200);

		expect((await post("/sign-out", {}, { cookie })).status).toBe(200);
		expectSentToSignIn(await ask(APP_PATH, {}, cookie), APP_PATH);
	});

	it("ended from another browser by sign out everywhere, the next move is sent to sign-in", async () => {
		const here = await signIn(mailbox, "ada@example.com");
		const elsewhere = await signIn(mailbox, "ada@example.com");

		expect((await post("/revoke-sessions", {}, { cookie: here.cookie })).status).toBe(200);
		await expectDataSentToSignIn(
			await ask(`${APP_PATH}/reports.data`, {}, elsewhere.cookie),
			`${APP_PATH}/reports`,
		);
	});
});

describe("the sign-in and sign-up pages", () => {
	it.each(["/sign-in", "/sign-up"])("%s is served to a person without a session", async (path) => {
		const response = await ask(path);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/html");
	});

	it.each(["/sign-in", "/sign-up"])("%s sends a signed-in person on to /app", async (path) => {
		const { cookie } = await signIn(mailbox, "ada@example.com");
		const response = await ask(path, {}, cookie);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(APP_PATH);
	});

	it("sends a signed-in person on to the page under /app they were going to", async () => {
		const { cookie } = await signIn(mailbox, "ada@example.com");
		const response = await ask("/sign-in?next=%2Fapp%2Freports%3Fweek%3D46", {}, cookie);
		expect(response.headers.get("Location")).toBe("/app/reports?week=46");
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
	it.each([
		["/app", "/app"],
		["/app/", "/app/"],
		["/app/reports", "/app/reports"],
		["/app/reports?week=46&team=a", "/app/reports?week=46&team=a"],
		// The fragment never reached the server and is not sent back.
		["/app/reports#totals", "/app/reports"],
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
		["a script", "javascript:alert(1)"],
		["a path with a space before it", " /app"],
	])("%s gives /app", (_case, next) => {
		expect(safeNext(next)).toBe("/app");
	});
});
