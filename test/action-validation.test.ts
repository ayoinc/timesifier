import { env, exports } from "cloudflare:workers";
import { routes } from "virtual:react-router/server-build";
import { afterEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { estimateToken } from "~/estimates/estimates.server";
import { makeToken } from "~/integrations/api-tokens.server";
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
	// A task's change is one of eight; deleting one is none of them (TS-066).
	"routes/app/tasks": () => formFromAMember("/app/acme/tasks", "intent=delete&taskId=t1"),
	// A project's type is hourly, fixed fee or non-billable; this is none of them (TS-067).
	"routes/app/project": () =>
		formFromAMember(
			"/app/acme/projects/p1",
			"intent=billing&billingType=barter&rateMode=project&currency=GBP",
		),
	// A default rate is a person's or a task's; a client's is neither (TS-067).
	"routes/app/rates": () =>
		formFromAMember(
			"/app/acme/projects/rates",
			"intent=rate&level=client&key=c1&amount=10&from=2026-12-01",
		),
	// A report is saved under a name; "keep" is not a thing a view does.
	"routes/app/reports": () =>
		formFromAMember("/app/acme/reports?range=this-week", "intent=keep&name=Mine"),
	"routes/app/reports.utilisation": () =>
		formFromAMember("/app/acme/reports/utilisation?range=this-week", "intent=keep&name=Mine"),
	"routes/app/reports.leave": () =>
		formFromAMember("/app/acme/reports/leave", "intent=keep&name=Mine"),
	// A cost rate starts on a date the calendar has; 31 February is not.
	"routes/app/reports.profitability": () =>
		formFromAMember(
			"/app/acme/reports/profitability",
			"intent=cost-rate&userId=u1&amount=40.00&effectiveFrom=2026-02-31",
		),
	// A saved report is renamed, deleted, shared or unshared; this asks to publish it.
	"routes/app/reports.saved": () =>
		formFromAMember("/app/acme/reports/saved", "intent=publish&reportId=r1"),
	// A request's first day is a date the calendar has; 31 February is not.
	"routes/app/time-off": () =>
		formFromAMember(
			"/app/acme/time-off",
			"intent=request&kindId=k1&startsOn=2026-02-31&endsOn=2026-03-02",
		),
	// A token may do one of seven things; "everything" is none of them.
	"routes/app/integrations": () =>
		formFromAMember("/app/acme/integrations", "intent=token-create&name=Zapier&scopes=everything"),
	// An import is of time, clients or projects; payroll is none of them.
	"routes/app/integrations.import": () =>
		formFromAMember("/app/acme/integrations/import", "intent=upload&kind=payroll&file=x"),
	// A feed follows its person or a team, named by an id of at most 64 characters.
	"routes/app/calendar-feeds": () =>
		formFromAMember("/app/acme/account/calendar", `intent=feed-create&follow=${"x".repeat(65)}`),
	// The API reads a JSON body; this one is cut short. The token is a real one.
	"routes/api.v1.$": async () => {
		await freshDatabase();
		const ada = await signIn(captureEmail(), "ada@example.com");
		const acme = await createOrganisation(ada.cookie, "Acme");
		const token = await makeToken(organisationScope(env.DB, acme.id), ada.user.id, "Test", [
			"time:write",
		]);
		return new Request("https://timesifier.example/api/v1/time_entries", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: '{"project_id": ',
		});
	},
	// An expense's day is a date the calendar has; 31 February is not.
	"routes/app/expenses": () =>
		formFromAMember(
			"/app/acme/expenses",
			"intent=record&spentOn=2026-02-31&projectId=p1&categoryId=c1&amount=1",
		),
	// An id is at most 64 characters; this client's is 65.
	"routes/app/invoices.new": () =>
		formFromAMember("/app/acme/invoices/new", `client=${"c".repeat(65)}`),
	// An invoice's change is one of eleven; this is none of them.
	"routes/app/invoices.$invoice": () => formFromAMember("/app/acme/invoices/i1", "intent=explode"),
	// Payment terms are 0 to 365 days; this is 400.
	"routes/app/invoices.settings": () =>
		formFromAMember(
			"/app/acme/invoices/settings",
			"intent=details&legalName=Acme&address=&taxNumber=&paymentTermsDays=400&defaultNotes=&lateReminderAfterDays=&lateReminderEveryDays=",
		),
	// An estimate's issue date is a date the calendar has; 31 February is not.
	"routes/app/estimates": () =>
		formFromAMember(
			"/app/acme/estimates",
			"intent=create&clientId=c1&currency=GBP&issuedOn=2026-02-31&subject=",
		),
	// An estimate's change is one of eleven; this is none of them.
	"routes/app/estimates.$estimate": () =>
		formFromAMember("/app/acme/estimates/e1", "intent=explode"),
	// A frequency is one of the listed; fortnightly-ish is not.
	"routes/app/invoices.recurring": () =>
		formFromAMember(
			"/app/acme/invoices/recurring",
			"intent=create&clientId=c1&currency=GBP&startsOn=2026-12-01&frequency=sometimes&endsOn=&paymentTermsDays=30&subject=&notes=",
		),
	// A recurring invoice's change is one of four; this is none of them.
	"routes/app/invoices.recurring.$recurring": () =>
		formFromAMember("/app/acme/invoices/recurring/r1", "intent=explode"),
	// A retainer's currency is a three-letter code; this is not.
	"routes/app/invoices.retainers": () =>
		formFromAMember(
			"/app/acme/invoices/retainers",
			"intent=open&clientId=c1&projectId=all&currency=pounds",
		),
	// A decision is accepted or declined; this is neither. The link is a real
	// one to a sent estimate, so only the input is wrong.
	"routes/estimate.$id.$token": async () => {
		await freshDatabase();
		const { cookie } = await signIn(captureEmail(), "ada@example.com");
		const acme = await createOrganisation(cookie, "Acme");
		const scope = organisationScope(env.DB, acme.id);
		const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
		const [estimate] = await scope.estimates.insert({
			number: "1",
			clientId: client?.id ?? "",
			status: "sent",
			currency: "GBP",
			issuedOn: "2026-11-12",
		});
		const id = estimate?.id ?? "";
		return form(`/estimate/${id}/${await estimateToken(id)}`, "decision=maybe", "");
	},
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
