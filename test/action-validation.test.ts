import { exports } from "cloudflare:workers";
import { routes } from "virtual:react-router/server-build";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEmail, signIn } from "./auth/harness";
import { freshDatabase } from "./db/database";
import { createOrganisation, invite } from "./organisations/harness";

/**
 * One malformed request for every route that exports an `action`, keyed by the
 * route's id (its file path under `app/` without the extension, for example
 * `routes/projects.new`). Each must be answered with status 400.
 *
 * A card that adds an action adds its case here; the registry test below fails
 * until it does. Build the request so it passes the origin check and any
 * sign-in the route needs, and is wrong only in its input.
 */
const malformedInput: Record<string, () => Request | Promise<Request>> = {
	// Better Auth validates its own endpoints; a body that is not JSON gets its 400.
	"routes/api.auth.$": async () => {
		// Its rate limit reads the database before it reads the body.
		await freshDatabase();
		return new Request("https://timesifier.example/api/auth/sign-in/email-otp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://timesifier.example",
				"CF-Connecting-IP": "203.0.113.7",
			},
			body: '{"email": "ada@example.com", "otp":',
		});
	},
	// An organisation's name is 1 to 80 characters; this is none.
	"routes/app/settings": () => formFromAMember("/app/acme/settings", "intent=rename&name="),
	// The colour scheme is one of three words; this is none of them.
	"routes/app/account": () => formFromAMember("/app/acme/account", "scheme=sepia"),
	// A description is at most 500 characters; this is 501.
	"routes/app/timesheet": () =>
		formFromAMember(
			"/app/acme?index",
			`intent=track&projectId=p1&day=2026-11-11&description=${"x".repeat(501)}`,
		),
	// An organisation's name is 1 to 80 characters; this is none.
	"routes/app/new": () => formFromAMember("/app/new", "name="),
	// A role is one of three words; this is none of them.
	"routes/app/members": () =>
		formFromAMember("/app/acme/team/members", "intent=role&memberId=m1&role=emperor"),
	// A team's change is one of six; this is none of them.
	"routes/app/team": () => formFromAMember("/app/acme/team", "intent=dissolve&teamId=t1"),
	// A decision is one of four; this is none of them.
	"routes/app/approvals": () => formFromAMember("/app/acme/approvals", "intent=reject&periodId=p1"),
	// An invitation gives the role of a member or an admin; this is neither.
	"routes/app/invitations": () =>
		formFromAMember("/app/acme/team/invitations", "intent=invite&email=bob@example.com&role=owner"),
	// A project is created, renamed, archived or restored; this asks to delete one.
	"routes/app/projects": () => formFromAMember("/app/acme/projects", "intent=delete&projectId=p1"),
	// A client's name is 1 to 120 characters; this is none.
	"routes/app/clients": () => formFromAMember("/app/acme/clients", "intent=create&name="),
	// An invitation is joined or declined; this asks for neither. The invitation
	// is one the person could join, so only the input is wrong.
	"routes/invitations.$id": async () => {
		await freshDatabase();
		const mailbox = captureEmail();
		const ada = await signIn(mailbox, "ada@example.com");
		const acme = await createOrganisation(ada.cookie, "Acme");
		const { id } = await invite(ada.cookie, acme.id, "bob@example.com");
		const bob = await signIn(mailbox, "bob@example.com", { client: "203.0.113.8" });
		return form(`/invitations/${id}`, "intent=keep", bob.cookie);
	},
};

/** A form as a browser posts it from our own page, with the session of the person posting. */
function form(path: string, body: string, cookie: string): Request {
	return new Request(`https://timesifier.example${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Origin: "https://timesifier.example",
			Cookie: cookie,
		},
		body,
	});
}

/**
 * The same, from a person who has signed in and owns the organisation at
 * `/app/acme`: everything under `/app` needs a session, and an organisation's
 * pages need a member. Only the input is wrong.
 */
async function formFromAMember(path: string, body: string): Promise<Request> {
	await freshDatabase();
	const { cookie } = await signIn(captureEmail(), "ada@example.com");
	await createOrganisation(cookie, "Acme");
	return form(path, body, cookie);
}

const routesWithAction = Object.values(routes)
	.filter((route) => route !== undefined && route.module.action !== undefined)
	.map((route) => route?.id ?? "");

afterEach(() => {
	vi.restoreAllMocks();
});
describe("every action validates its input", () => {
	it("has a malformed-input case for every route that exports an action", () => {
		const missing = routesWithAction.filter((id) => !(id in malformedInput));
		expect(missing, "routes with an action and no case in malformedInput").toEqual([]);
	});

	it("has no case for a route without an action", () => {
		const stale = Object.keys(malformedInput).filter((id) => !routesWithAction.includes(id));
		expect(stale, "cases in malformedInput whose route has no action").toEqual([]);
	});

	it.each(Object.entries(malformedInput))(
		"%s answers malformed input with 400",
		async (_id, request) => {
			const response = await exports.default.fetch(await request());
			expect(response.status).toBe(400);
		},
	);
});
