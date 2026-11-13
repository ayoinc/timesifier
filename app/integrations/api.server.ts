import { env, waitUntil } from "cloudflare:workers";
import { and, desc, eq, gte, inArray, lt, lte, or, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as z from "zod";

import { users } from "~/db";
import { dayStatus } from "~/leave/days";
import { calendarOf, leaveContext } from "~/leave/leave.server";
import {
	type Access,
	isAdministrator,
	mayInvoice,
	maySeeExpensesOf,
	maySeeLeaveKindOf,
	maySeeRates,
	timeScopeOf,
} from "~/organisations/access";
import { clockTime } from "~/schedules/schedules";
import { canSee } from "~/shell/destinations";
import { bounds, Day, dayOf, daysFrom } from "~/time/calendar";
import { addHours, deleteEntry, editEntry } from "~/time/manual.server";

import { authenticate, type TokenCaller } from "./api-tokens.server";
import { viewerOfCaller, zoneOfCaller } from "./caller.server";
import { API_PATH } from "./paths";
import type { ApiScope } from "./scopes";
import { dispatchWebhooks } from "./webhooks.server";

/**
 * The public API (TS-081), at `/api/v1/…`. A request carries an API token as
 * `Authorization: Bearer tsf_…`; it acts as the token's maker, with their role
 * as it is now, and only within the token's scopes. Each resource obeys the
 * rules its page obeys (`app/organisations/access.ts`): whose time, whose
 * expenses and which money the maker may see, and that nobody changes anybody's
 * entries but their own. Writes go through the same functions the Timesheet
 * uses, so the same locks hold, and are recorded in the activity log with the
 * source `api`. Everything answers JSON; `docs/api.md` and `docs/openapi.yaml`
 * describe it.
 */

/** The most rows one page of a list holds. */
const MAX_PAGE = 100;

/** The longest range one request for entries or leave may ask for, in days. */
const MAX_RANGE_DAYS = 366;

type Json = Record<string, unknown>;

/** A JSON answer, never cached. */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: {
			...(status === 204 ? {} : { "Content-Type": "application/json; charset=utf-8" }),
			"Cache-Control": "no-store",
			...headers,
		},
	});
}

/** An error answer: `{ "error": { "code", "message" } }`. */
function problem(
	status: number,
	code: string,
	message: string,
	headers: Record<string, string> = {},
) {
	return json({ error: { code, message } }, status, headers);
}

const notFound = () => problem(404, "not_found", "There is nothing at this address.");

function missingScope(scope: ApiScope) {
	return problem(403, "insufficient_scope", `This token does not have the ${scope} scope.`);
}

const forbidden = (message: string) => problem(403, "forbidden", message);

/** The answer to a request of `method` for `request`'s address under `/api/v1`. */
export async function handleApiRequest(request: Request, now = Date.now()): Promise<Response> {
	const signedIn = await authenticate(request, now);
	if (!signedIn.ok) {
		const { refusal } = signedIn;
		if (refusal.status === 429) {
			return problem(429, "rate_limited", "Too many requests: wait, then try again.", {
				"Retry-After": String(refusal.retryAfter),
			});
		}
		return problem(401, "unauthorized", "Send a working API token as a Bearer token.", {
			"WWW-Authenticate": 'Bearer realm="timesifier"',
		});
	}
	const { caller } = signedIn;
	const url = new URL(request.url);
	const parts = url.pathname
		.slice(API_PATH.length)
		.split("/")
		.filter((part) => part !== "");
	const method = request.method.toUpperCase();
	const [resource, id, ...rest] = parts;
	if (rest.length > 0 || resource === undefined) return notFound();

	const route = ROUTES[resource];
	if (!route) return notFound();
	const handler = id === undefined ? route.collection?.[method] : route.item?.[method];
	if (!handler) {
		const allowed = Object.keys((id === undefined ? route.collection : route.item) ?? {});
		if (allowed.length === 0) return notFound();
		return problem(405, "method_not_allowed", `Use ${allowed.join(" or ")}.`, {
			Allow: allowed.join(", "),
		});
	}
	if (!caller.scopes.has(route.scope[method === "GET" ? "read" : "write"] as ApiScope)) {
		return missingScope(route.scope[method === "GET" ? "read" : "write"] as ApiScope);
	}
	return handler({ caller, request, url, id: id ?? "", now });
}

interface Call {
	caller: TokenCaller;
	request: Request;
	url: URL;
	id: string;
	now: number;
}

type Handler = (call: Call) => Promise<Response>;

interface ApiRoute {
	scope: { read: ApiScope; write?: ApiScope };
	collection?: Record<string, Handler>;
	item?: Record<string, Handler>;
}

const ROUTES: Record<string, ApiRoute> = {
	me: { scope: { read: "time:read" }, collection: { GET: me } },
	users: { scope: { read: "people:read" }, collection: { GET: listUsers } },
	clients: { scope: { read: "projects:read" }, collection: { GET: listClients } },
	projects: { scope: { read: "projects:read" }, collection: { GET: listProjects } },
	tasks: { scope: { read: "projects:read" }, collection: { GET: listTasks } },
	time_entries: {
		scope: { read: "time:read", write: "time:write" },
		collection: { GET: listEntries, POST: createEntry },
		item: { GET: showEntry, PATCH: changeEntry, DELETE: removeEntry },
	},
	leave: { scope: { read: "people:read" }, collection: { GET: listLeave } },
	work_days: { scope: { read: "time:read" }, collection: { GET: listWorkDays } },
	expenses: { scope: { read: "expenses:read" }, collection: { GET: listExpenses } },
	invoices: { scope: { read: "invoices:read" }, collection: { GET: listInvoices } },
};

// ── Reading the query ────────────────────────────────────────────────────────

const PageQuery = z.object({
	per_page: z.coerce.number().int().min(1).max(MAX_PAGE).default(MAX_PAGE),
	cursor: z.string().max(200).optional(),
});

const RangeQuery = z
	.object({
		from: Day.optional(),
		to: Day.optional(),
		user_id: z.string().min(1).max(64).optional(),
		project_id: z.string().min(1).max(64).optional(),
	})
	.refine(({ from, to }) => !from || !to || from <= to, "`to` is before `from`.");

function queryOf<S extends z.ZodType>(url: URL, schema: S) {
	const given = Object.fromEntries(
		[...url.searchParams].filter(([, value]) => value !== ""),
	) as Record<string, string>;
	return schema.safeParse(given);
}

function invalid(error: z.ZodError): Response {
	return json(
		{
			error: {
				code: "invalid",
				message: "The request has values that cannot be used.",
				fields: Object.fromEntries(
					error.issues.map((issue) => [issue.path.join(".") || "request", issue.message]),
				),
			},
		},
		422,
	);
}

/** A cursor names the last row of the page before: its sort value and id. */
function readCursor(cursor: string | undefined): { at: number; id: string } | null {
	if (!cursor) return null;
	const [at, id] = cursor.split("_", 2);
	const instant = Number(at);
	return Number.isSafeInteger(instant) && id ? { at: instant, id } : null;
}

/** The page of `rows` to answer with: at most `perPage`, and the cursor of the next page, if one. */
function page<R>(rows: R[], perPage: number, cursorOf: (row: R) => string) {
	const shown = rows.slice(0, perPage);
	const last = shown.at(-1);
	return {
		data: shown,
		next_cursor: rows.length > perPage && last !== undefined ? cursorOf(last) : null,
	};
}

/** Whose rows the caller may read: the people a query is limited to, or null for everyone. */
function peopleOf(access: Access, asked: string | undefined): string[] | null | "none" {
	const scope = timeScopeOf(access);
	if (asked) return scope.everyone || scope.people.includes(asked) ? [asked] : "none";
	return scope.everyone ? null : scope.people;
}

// ── Names ────────────────────────────────────────────────────────────────────

async function namesOfPeople(ids: Iterable<string>): Promise<Map<string, string>> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return new Map();
	const rows = await drizzle(env.DB)
		.select({ id: users.id, name: users.name })
		.from(users)
		.where(inArray(users.id, unique));
	return new Map(rows.map((row) => [row.id, row.name]));
}

const ref = (id: string | null, names: Map<string, string>) =>
	id === null ? null : { id, name: names.get(id) ?? null };

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

// ── Me, people, clients, projects, tasks ────────────────────────────────────

async function me({ caller }: Call) {
	return json({
		user: { id: caller.user.id, name: caller.user.name },
		organisation: {
			id: caller.organisation.id,
			name: caller.organisation.name,
			slug: caller.organisation.slug,
			time_zone: caller.organisation.timeZone,
		},
		role: caller.role,
		manages_teams: caller.managesTeams,
		scopes: [...caller.scopes],
	});
}

async function listUsers({ caller }: Call) {
	const people = peopleOf(caller.access, undefined);
	if (people === "none") return json({ data: [] });
	const memberships = await caller.scope.memberships.select((m) =>
		people === null ? undefined : inArray(m.userId, people),
	);
	const rows = memberships.length
		? await drizzle(env.DB)
				.select({ id: users.id, name: users.name, email: users.email })
				.from(users)
				.where(
					inArray(
						users.id,
						memberships.map((m) => m.userId),
					),
				)
		: [];
	const byId = new Map(rows.map((row) => [row.id, row]));
	const administrator = isAdministrator(caller.role);
	return json({
		data: memberships
			.map((membership) => {
				const person = byId.get(membership.userId);
				return {
					id: membership.userId,
					name: person?.name ?? null,
					// An address is for those who administer people, as on Team.
					...(administrator ? { email: person?.email ?? null } : {}),
					role: membership.role,
					is_contractor: membership.isContractor,
				};
			})
			.sort((a, b) => String(a.name).localeCompare(String(b.name))),
	});
}

async function listClients({ caller }: Call) {
	if (!canSee(viewerOfCaller(caller), "clients")) {
		return forbidden("This token's maker is not shown Clients.");
	}
	const clients = await caller.scope.clients.select(undefined, { orderBy: (c) => [c.nameKey] });
	return json({
		data: clients.map((client) => ({
			id: client.id,
			name: client.name,
			archived: client.archivedAt !== null,
			currency: client.currency,
		})),
	});
}

async function listProjects({ caller }: Call) {
	const [projects, clients] = await Promise.all([
		caller.scope.projects.select(undefined, { orderBy: (p) => [p.nameKey] }),
		caller.scope.clients.select(),
	]);
	const clientNames = new Map(clients.map((client) => [client.id, client.name]));
	const money = maySeeRates(caller.role);
	return json({
		data: projects.map((project) => ({
			id: project.id,
			name: project.name,
			client: caller.organisation.clientsEnabled ? ref(project.clientId, clientNames) : null,
			archived: project.archivedAt !== null,
			// Money is for those the pages show it to (docs/security.md, "Rates and money").
			...(money
				? {
						billing_type: project.billingType,
						rate_mode: project.rateMode,
						fee_minor: project.feeMinor,
						currency: project.currency,
						budget: {
							kind: project.budgetKind,
							amount: project.budgetAmount,
							resets_monthly: project.budgetResetsMonthly,
						},
					}
				: {}),
		})),
	});
}

async function listTasks({ caller }: Call) {
	const [tasks, links] = await Promise.all([
		caller.scope.tasks.select(undefined, { orderBy: (t) => [t.nameKey] }),
		caller.scope.projectTasks.select(),
	]);
	return json({
		data: tasks.map((task) => ({
			id: task.id,
			name: task.name,
			archived: task.archivedAt !== null,
			billable_by_default: task.billableByDefault,
			common: task.common,
			projects: links
				.filter((link) => link.taskId === task.id)
				.map((link) => ({ id: link.projectId, billable: link.billable })),
		})),
	});
}

// ── Time entries ─────────────────────────────────────────────────────────────

/** What the API reads of a time entry. */
interface EntryRow {
	id: string;
	userId: string;
	projectId: string;
	taskId: string | null;
	description: string | null;
	startedAt: Date;
	endedAt: Date | null;
	billable: boolean;
	overtime: boolean;
	importId: string | null;
	createdAt: Date;
	updatedAt: Date;
	spentOn: string;
}

/** Entries as the API shows them: names beside ids, their stored day, and descriptions only with the scope. */
async function entriesOut(caller: TokenCaller, entries: EntryRow[], now: number): Promise<Json[]> {
	const [people, projects, clients, tasks] = await Promise.all([
		namesOfPeople(entries.map((e) => e.userId)),
		caller.scope.projects.select((p) =>
			inArray(
				p.id,
				entries.map((e) => e.projectId),
			),
		),
		caller.scope.clients.select(),
		caller.scope.tasks.select(),
	]);
	const projectById = new Map(projects.map((p) => [p.id, p]));
	const clientNames = new Map(clients.map((c) => [c.id, c.name]));
	const taskNames = new Map(tasks.map((t) => [t.id, t.name]));
	const describe = caller.scopes.has("descriptions:read");
	return entries.map((entry) => {
		const project = projectById.get(entry.projectId);
		const end = entry.endedAt?.getTime() ?? now;
		return {
			id: entry.id,
			user: ref(entry.userId, people),
			project: project
				? { id: project.id, name: project.name }
				: { id: entry.projectId, name: null },
			client:
				caller.organisation.clientsEnabled && project?.clientId
					? ref(project.clientId, clientNames)
					: null,
			task: ref(entry.taskId, taskNames),
			spent_date: entry.spentOn,
			started_at: iso(entry.startedAt),
			ended_at: iso(entry.endedAt),
			running: entry.endedAt === null,
			hours: Math.round(((end - entry.startedAt.getTime()) / 3_600_000) * 100) / 100,
			overtime: entry.overtime,
			billable: entry.billable,
			...(describe ? { description: entry.description } : {}),
			import_id: entry.importId,
			created_at: iso(entry.createdAt),
			updated_at: iso(entry.updatedAt),
		};
	});
}

async function listEntries({ caller, url, now }: Call) {
	const range = queryOf(url, RangeQuery);
	const paging = queryOf(url, PageQuery);
	if (!range.success) return invalid(range.error);
	if (!paging.success) return invalid(paging.error);
	const { from, to, user_id, project_id } = range.data;
	if (from && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 >= MAX_RANGE_DAYS) {
		return problem(422, "invalid", `A range is at most ${MAX_RANGE_DAYS} days.`);
	}
	const people = peopleOf(caller.access, user_id);
	if (people === "none") return json({ data: [], next_cursor: null });
	const cursor = readCursor(paging.data.cursor);
	const perPage = paging.data.per_page;
	const entries = await caller.scope.timeEntries.select(
		(e) => {
			const conditions: (SQL | undefined)[] = [];
			if (people !== null) conditions.push(inArray(e.userId, people));
			if (project_id) conditions.push(eq(e.projectId, project_id));
			// Each entry's own day, stored in its person's zone (TS-111).
			if (from) conditions.push(gte(e.spentOn, from));
			if (to) conditions.push(lte(e.spentOn, to));
			if (cursor) {
				conditions.push(
					or(
						lt(e.startedAt, new Date(cursor.at)),
						and(eq(e.startedAt, new Date(cursor.at)), lt(e.id, cursor.id)),
					),
				);
			}
			return conditions.length ? and(...conditions) : undefined;
		},
		{ orderBy: (e) => [desc(e.startedAt), desc(e.id)], limit: perPage + 1 },
	);
	const shown = await entriesOut(caller, entries, now);
	return json(
		page(shown, perPage, (row) => `${Date.parse(String(row.started_at))}_${String(row.id)}`),
	);
}

/** The entry `id`, when the caller may see it; null otherwise, which answers 404 alike. */
async function visibleEntry(caller: TokenCaller, id: string) {
	const [entry] = await caller.scope.timeEntries.select((e) => eq(e.id, id), { limit: 1 });
	if (!entry) return null;
	const people = peopleOf(caller.access, entry.userId);
	return people === "none" ? null : entry;
}

async function showEntry({ caller, id, now }: Call) {
	const entry = await visibleEntry(caller, id);
	if (!entry) return notFound();
	const [shown] = await entriesOut(caller, [entry], now);
	return json(shown);
}

const Description = z.string().trim().max(2000).nullable().optional();

const NewEntry = z
	.object({
		user_id: z.string().max(64).optional(),
		project_id: z.string().min(1).max(64),
		task_id: z.string().min(1).max(64).optional(),
		spent_date: Day.optional(),
		started_at: z.iso.datetime({ offset: true }).optional(),
		hours: z.number().positive().max(24).optional(),
		description: Description,
		/** Whether the hours are overtime (TS-095): held to the organisation's rules, as on the Timesheet. */
		overtime: z.boolean().optional(),
	})
	.strict()
	.refine((body) => body.spent_date !== undefined || body.started_at !== undefined, {
		message: "Give `spent_date` or `started_at`.",
		path: ["spent_date"],
	})
	.refine((body) => body.hours !== undefined, { message: "Give `hours`.", path: ["hours"] });

const EntryChange = z
	.object({
		project_id: z.string().min(1).max(64).optional(),
		task_id: z.string().min(1).max(64).optional(),
		started_at: z.iso.datetime({ offset: true }).optional(),
		ended_at: z.iso.datetime({ offset: true }).optional(),
		hours: z.number().positive().max(24).optional(),
		description: Description,
		overtime: z.boolean().optional(),
	})
	.strict()
	.refine((body) => !(body.ended_at && body.hours), {
		message: "Give `ended_at` or `hours`, not both.",
		path: ["hours"],
	});

/** The request's JSON body, checked against `schema`; or the answer to give instead. */
async function bodyOf<S extends z.ZodType>(
	request: Request,
	schema: S,
): Promise<{ ok: true; data: z.output<S> } | { ok: false; response: Response }> {
	if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
		return {
			ok: false,
			response: problem(415, "unsupported_media_type", "Send the body as application/json."),
		};
	}
	const text = await request.text();
	if (text.length > 16 * 1024) {
		return { ok: false, response: problem(413, "too_large", "A body is at most 16 KB.") };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, response: problem(400, "bad_json", "The body is not JSON.") };
	}
	const parsed = schema.safeParse(raw);
	return parsed.success
		? { ok: true, data: parsed.data }
		: { ok: false, response: invalid(parsed.error) };
}

/**
 * What a refused write answers, by why the Timesheet functions refused it;
 * a refusal that says why itself (a day's limit, TS-090; a full day) says so here too.
 */
function refused(refusal: { reason: string; message?: string }): Response {
	const { reason, message } = refusal;
	switch (reason) {
		case "not-found":
			return notFound();
		case "locked":
			return problem(409, "locked", "That day is locked: its period is submitted or approved.");
		case "running":
			return problem(409, "running", "A running entry is changed by stopping its timer.");
		case "ends-before-start":
			return problem(422, "invalid", "An entry ends after it starts.");
		case "no-project":
			return problem(422, "invalid", "Choose an active project of this organisation.");
		default:
			return problem(422, "invalid", message ?? `The entry was not written: ${reason}.`);
	}
}

/** After a write, an organisation's webhooks hear of it now rather than at the next minute. */
async function tellWebhooks(caller: TokenCaller, now: number) {
	const [active] = await caller.scope.webhooks.select((w) => eq(w.active, true), { limit: 1 });
	if (active) waitUntil(dispatchWebhooks({ organisations: [caller.organisation.id], now }));
}

async function createEntry({ caller, request, now }: Call) {
	const body = await bodyOf(request, NewEntry);
	if (!body.ok) return body.response;
	const { user_id, project_id, task_id, spent_date, started_at, hours, description, overtime } =
		body.data;
	// Nobody changes anybody's entries but their own (decision 25), on a page or here.
	if (user_id !== undefined && user_id !== caller.user.id) {
		return forbidden("A token adds its maker's own time, and nobody else's.");
	}
	const zone = zoneOfCaller(caller);
	const startedAt = started_at === undefined ? undefined : Date.parse(started_at);
	const day = startedAt === undefined ? (spent_date as Day) : dayOf(startedAt, zone);
	if (spent_date !== undefined && spent_date !== day) {
		return problem(422, "invalid", "`started_at` is not on `spent_date`.");
	}
	// The task travels to the Timesheet's own rules where they take one (TS-067).
	const dayHours = {
		projectId: project_id,
		taskId: task_id,
		description: description?.length ? description : null,
		day,
		minutes: Math.round((hours ?? 0) * 60),
		startedAt,
		zone,
		now,
		overtime,
	};
	const written = await addHours(caller.scope, caller.user.id, dayHours, "api");
	if (!written.ok) return refused(written);
	await tellWebhooks(caller, now);
	const [shown] = await entriesOut(caller, [written.entry as EntryRow], now);
	return json(shown, 201, {
		Location: `${API_PATH}/time_entries/${written.entry?.id ?? ""}`,
	});
}

async function changeEntry({ caller, request, id, now }: Call) {
	const body = await bodyOf(request, EntryChange);
	if (!body.ok) return body.response;
	const entry = await visibleEntry(caller, id);
	if (!entry) return notFound();
	if (entry.userId !== caller.user.id) {
		return forbidden("A token changes its maker's own entries, and nobody else's.");
	}
	if (entry.endedAt === null) return refused({ reason: "running" });
	const { project_id, task_id, started_at, ended_at, hours, description, overtime } = body.data;
	const startedAt = started_at === undefined ? entry.startedAt.getTime() : Date.parse(started_at);
	const length = entry.endedAt.getTime() - entry.startedAt.getTime();
	const endedAt =
		ended_at !== undefined
			? Date.parse(ended_at)
			: hours !== undefined
				? startedAt + Math.round(hours * 60) * 60_000
				: startedAt + length;
	const span = {
		projectId: project_id ?? entry.projectId,
		taskId: task_id,
		description:
			description === undefined ? entry.description : description?.length ? description : null,
		startedAt,
		endedAt,
		overtime,
	};
	const written = await editEntry(
		caller.scope,
		caller.user.id,
		zoneOfCaller(caller),
		id,
		span,
		now,
		"api",
	);
	if (!written.ok) return refused(written);
	await tellWebhooks(caller, now);
	return showEntry({ caller, request, url: new URL(request.url), id, now });
}

async function removeEntry({ caller, id, now }: Call) {
	const entry = await visibleEntry(caller, id);
	if (!entry) return notFound();
	if (entry.userId !== caller.user.id) {
		return forbidden("A token deletes its maker's own entries, and nobody else's.");
	}
	const written = await deleteEntry(caller.scope, caller.user.id, id, "api");
	if (!written.ok) return refused(written);
	await tellWebhooks(caller, now);
	return json(null, 204);
}

// ── Work days (TS-097) ───────────────────────────────────────────────────────

/** Each day's work as the person's schedule sets it: required `from` and `to`, at most 62 days. */
const WorkDaysQuery = z
	.object({ from: Day, to: Day, user_id: z.string().min(1).max(64).optional() })
	.refine(({ from, to }) => from <= to, "`to` is before `from`.");

/** The longest range of work days one request may ask for. */
const MAX_WORK_DAYS = 62;

/**
 * The days of the people whose time the maker may see (their own, else the
 * user asked for): each with the schedule in force that day, its start,
 * finish and break, and the minutes expected after public holidays and
 * approved leave, as the Timesheet holds them. Leave is named as the live
 * status names it, without its kind.
 */
async function listWorkDays({ caller, url }: Call) {
	const query = queryOf(url, WorkDaysQuery);
	if (!query.success) return invalid(query.error);
	const { from, to, user_id } = query.data;
	if (daysFrom(from, to).length > MAX_WORK_DAYS) {
		return problem(422, "invalid", `A range of work days is at most ${MAX_WORK_DAYS} days.`);
	}
	const people = peopleOf(caller.access, user_id ?? caller.user.id);
	if (people === "none" || people === null) return json({ data: [] });
	const context = await leaveContext(caller.scope, people, from, to);
	const days = daysFrom(from, to);
	return json({
		data: people.flatMap((userId) => {
			const calendar = calendarOf(context, userId);
			return days.map((day) => {
				const status = dayStatus(calendar, day);
				const scheduled = calendar.timetable(day);
				return {
					user_id: userId,
					date: day,
					schedule: { id: scheduled.scheduleId, name: scheduled.scheduleName },
					kind: status.is.kind,
					half_day: status.is.kind === "leave" && status.is.halves === 1,
					start: scheduled.worked ? clockTime(scheduled.worked.start) : null,
					finish: scheduled.worked ? clockTime(scheduled.worked.finish) : null,
					break_minutes: scheduled.worked?.breakMinutes ?? null,
					scheduled_minutes: scheduled.minutes,
					expected_minutes: status.expectedMinutes,
				};
			});
		}),
	});
}

// ── Leave, expenses, invoices ────────────────────────────────────────────────

async function listLeave({ caller, url }: Call) {
	const range = queryOf(url, RangeQuery);
	if (!range.success) return invalid(range.error);
	const { from, to, user_id } = range.data;
	// Everyone sees that a colleague is on leave, as the live status says; the
	// kind, and requests not yet approved, only where the pages show them.
	const requests = await caller.scope.leaveRequests.select(
		(l) =>
			and(
				user_id ? eq(l.userId, user_id) : undefined,
				to ? lte(l.startsOn, to) : undefined,
				from ? gte(l.endsOn, from) : undefined,
				or(eq(l.status, "approved"), eq(l.userId, caller.user.id)),
			),
		{ orderBy: (l) => [l.startsOn], limit: 1000 },
	);
	const [people, kinds] = await Promise.all([
		namesOfPeople(requests.map((r) => r.userId)),
		caller.scope.leaveKinds.select(),
	]);
	const kindNames = new Map(kinds.map((kind) => [kind.id, kind.name]));
	return json({
		data: requests.map((request) => ({
			id: request.id,
			user: ref(request.userId, people),
			kind: maySeeLeaveKindOf(caller.access, request.userId)
				? ref(request.kindId, kindNames)
				: null,
			starts_on: request.startsOn,
			ends_on: request.endsOn,
			starts_half: request.startsHalf,
			ends_half: request.endsHalf,
			status: request.status,
		})),
	});
}

async function listExpenses({ caller, url }: Call) {
	const range = queryOf(url, RangeQuery);
	const paging = queryOf(url, PageQuery);
	if (!range.success) return invalid(range.error);
	if (!paging.success) return invalid(paging.error);
	const { from, to, user_id, project_id } = range.data;
	if (user_id && !maySeeExpensesOf(caller.access, user_id)) {
		return json({ data: [], next_cursor: null });
	}
	const people = peopleOf(caller.access, user_id);
	if (people === "none") return json({ data: [], next_cursor: null });
	const perPage = paging.data.per_page;
	const cursor = paging.data.cursor;
	const expenses = await caller.scope.expenses.select(
		(x) =>
			and(
				people === null ? undefined : inArray(x.userId, people),
				project_id ? eq(x.projectId, project_id) : undefined,
				from ? gte(x.spentOn, from) : undefined,
				to ? lte(x.spentOn, to) : undefined,
				cursor ? lt(x.id, cursor) : undefined,
			),
		{ orderBy: (x) => [desc(x.id)], limit: perPage + 1 },
	);
	const [names, projects, categories] = await Promise.all([
		namesOfPeople(expenses.map((x) => x.userId)),
		caller.scope.projects.select(),
		caller.scope.expenseCategories.select(),
	]);
	const projectNames = new Map(projects.map((p) => [p.id, p.name]));
	const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
	const describe = caller.scopes.has("descriptions:read");
	const rows = expenses
		.filter((x) => maySeeExpensesOf(caller.access, x.userId))
		.map((x) => ({
			id: x.id,
			user: ref(x.userId, names),
			project: ref(x.projectId, projectNames),
			category: ref(x.categoryId, categoryNames),
			spent_on: x.spentOn,
			amount_minor: x.amountMinor,
			currency: x.currency,
			billable: x.billable,
			reimbursable: x.reimbursable,
			...(describe ? { notes: x.notes } : {}),
			has_receipt: x.receiptKey !== null,
			created_at: iso(x.createdAt),
		}));
	return json(page(rows, perPage, (row) => row.id));
}

async function listInvoices({ caller, url }: Call) {
	if (!mayInvoice(caller.role)) return forbidden("This token's maker does not see invoices.");
	const paging = queryOf(url, PageQuery);
	if (!paging.success) return invalid(paging.error);
	const perPage = paging.data.per_page;
	const cursor = paging.data.cursor;
	const [invoices, clients] = await Promise.all([
		caller.scope.invoices.select((i) => (cursor ? lt(i.id, cursor) : undefined), {
			orderBy: (i) => [desc(i.id)],
			limit: perPage + 1,
		}),
		caller.scope.clients.select(),
	]);
	const clientNames = new Map(clients.map((c) => [c.id, c.name]));
	const rows = invoices.map((invoice) => ({
		id: invoice.id,
		number: invoice.number,
		client: ref(invoice.clientId, clientNames),
		status: invoice.status,
		currency: invoice.currency,
		issued_on: invoice.issuedOn,
		due_on: invoice.dueOn,
		subject: invoice.subject,
		subtotal_minor: invoice.subtotalMinor,
		discount_minor: invoice.discountMinor,
		tax_minor: invoice.taxMinor,
		total_minor: invoice.totalMinor,
		sent_at: iso(invoice.sentAt),
		voided_at: iso(invoice.voidedAt),
		created_at: iso(invoice.createdAt),
	}));
	return json(page(rows, perPage, (row) => row.id));
}

/** The entry `id` as the API shows it to `caller`, for a webhook's delivery; null when they may not see it. */
export async function entryAsApiShows(
	caller: TokenCaller,
	id: string,
	now: number,
): Promise<Json | null> {
	const entry = await visibleEntry(caller, id);
	if (!entry) return null;
	const [shown] = await entriesOut(caller, [entry], now);
	return shown ?? null;
}
