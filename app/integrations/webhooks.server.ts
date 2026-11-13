import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { record } from "~/activity/activity.server";
import { sendEmail } from "~/auth/email.server";
import { compose } from "~/auth/email-frame";
import { getPlatformBrand } from "~/brand/platform-brand.server";
import {
	type ActivitySummary,
	activityAfter,
	type OrganisationScope,
	organisationScope,
	organisationsWithWebhooks,
	users,
	uuidv7,
} from "~/db";
import { setting } from "~/lib/deployment";
import { mayInvoice, maySeeExpensesOf, maySeeTimeOf } from "~/organisations/access";
import { destinationPath } from "~/shell/destinations";
import { entryAsApiShows } from "./api.server";
import type { TokenCaller } from "./api-tokens.server";
import { type Caller, callerOf } from "./caller.server";
import { eventOf, type WebhookEvent } from "./scopes";
import { hashWebhookSecret, signWebhook, webhookSecret } from "./tokens.server";

/**
 * Webhooks (TS-087). An owner or admin gives an `https` address and the kinds
 * of event it hears about. Every activity record of those kinds becomes a
 * delivery: a JSON body, stored as it is sent, signed `t=…,v1=…` with
 * HMAC-SHA-256 under the webhook's secret (`tokens.server.ts`), which is
 * derived and never stored. The body holds what the webhook's maker would read
 * through the API, as they are now: an entry of someone they may not see is
 * not sent, and its description only when the webhook was given that.
 *
 * The dispatcher runs every minute from the Worker's cron trigger, and at once
 * after a write through the API. A delivery the receiver does not answer with
 * 2xx is tried again after `BACKOFF_MINUTES`; once it has used every attempt
 * it fails, and after `SWITCH_OFF_AFTER` failed deliveries in a row the
 * webhook is switched off and its maker is told by email.
 */

/** The wait before each attempt after the first, in minutes: about 21 hours in all. */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 360, 720] as const;

/** Attempts a delivery is given: the first and one after each wait. */
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;

/** Failed deliveries in a row that switch a webhook off. */
export const SWITCH_OFF_AFTER = 3;

/** How long a receiver has to answer, in milliseconds. */
const TIMEOUT_MS = 10_000;

/** What one run of the dispatcher takes on, so a run ends well inside a minute. */
const ORGANISATIONS_PER_RUN = 50;
const RECORDS_PER_WEBHOOK = 100;
const DELIVERIES_PER_ORGANISATION = 50;

/** The header the signature travels in. */
export const SIGNATURE_HEADER = "Timesifier-Signature";

/**
 * Why an address cannot be a webhook's, or null when it can: it must be
 * `https`, name a host by name rather than by number, and not be this
 * application or a machine's own name.
 */
export function webhookAddressProblem(address: string, ownHost: string | null): string | null {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		return "Enter a whole address, starting https://.";
	}
	if (url.protocol !== "https:") return "The address must start https://.";
	if (url.username || url.password) return "Leave the user name and password out of the address.";
	const host = url.hostname.toLowerCase();
	if (
		/^[\d.]+$/.test(host) ||
		host.startsWith("[") ||
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		!host.includes(".")
	) {
		return "The address must name a public host.";
	}
	if (ownHost !== null && host === ownHost.toLowerCase()) {
		return "A webhook cannot send to Timesifier itself.";
	}
	return null;
}

// ── On Integrations ──────────────────────────────────────────────────────────

/** The organisation's webhooks, each with its last deliveries, newest first. */
export async function listWebhooks(scope: OrganisationScope, deliveriesEach = 10) {
	const hooks = await scope.webhooks.select(undefined, { orderBy: (w) => [desc(w.createdAt)] });
	const deliveries = await Promise.all(
		hooks.map((hook) =>
			scope.webhookDeliveries.select((d) => eq(d.webhookId, hook.id), {
				orderBy: (d) => [desc(d.createdAt), desc(d.id)],
				limit: deliveriesEach,
			}),
		),
	);
	return hooks.map((hook, index) => ({
		id: hook.id,
		url: hook.url,
		events: hook.events as WebhookEvent[],
		includeDescriptions: hook.includeDescriptions,
		active: hook.active,
		lastStatus: hook.lastStatus,
		lastDeliveredAt: hook.lastDeliveredAt?.getTime() ?? null,
		failures: hook.failures,
		createdAt: hook.createdAt.getTime(),
		deliveries: (deliveries[index] ?? []).map((delivery) => ({
			id: delivery.id,
			event: delivery.event,
			status: delivery.status,
			attempts: delivery.attempts,
			lastStatus: delivery.lastStatus,
			lastError: delivery.lastError,
			nextAttemptAt: delivery.nextAttemptAt?.getTime() ?? null,
			createdAt: delivery.createdAt.getTime(),
		})),
	}));
}

export interface NewWebhook {
	url: string;
	events: readonly WebhookEvent[];
	includeDescriptions: boolean;
}

function signingSecret(id: string, version: number) {
	return webhookSecret(String(env.BETTER_AUTH_SECRET), id, version);
}

/** Adds a webhook made by `makerId` and records it. Returns its id and its secret, shown this once. */
export async function addWebhook(scope: OrganisationScope, makerId: string, hook: NewWebhook) {
	const id = uuidv7();
	const secret = await signingSecret(id, 1);
	await scope.webhooks.insert({
		id,
		url: hook.url,
		events: [...hook.events],
		includeDescriptions: hook.includeDescriptions,
		secretHash: await hashWebhookSecret(String(env.BETTER_AUTH_SECRET), secret),
		secretVersion: 1,
		createdBy: makerId,
	});
	await record(
		scope,
		makerId,
		"webhook.created",
		{ type: "webhook", id },
		{
			after: { url: hook.url, events: hook.events.join(" ") },
		},
	);
	return { id, secret };
}

/**
 * Gives webhook `id` a new secret: its version goes up, so the old secret
 * signs nothing more. Returns the new one, shown this once, or null when the
 * organisation has no such webhook.
 */
export async function rotateSecret(scope: OrganisationScope, actorId: string, id: string) {
	const [hook] = await scope.webhooks.select((w) => eq(w.id, id), { limit: 1 });
	if (!hook) return null;
	const version = hook.secretVersion + 1;
	const secret = await signingSecret(id, version);
	const [changed] = await scope.webhooks.update(
		{
			secretVersion: version,
			secretHash: await hashWebhookSecret(String(env.BETTER_AUTH_SECRET), secret),
		},
		// Only from the version read: two rotations at once give one secret.
		(w) => and(eq(w.id, id), eq(w.secretVersion, hook.secretVersion)),
	);
	if (!changed) return null;
	await record(
		scope,
		actorId,
		"webhook.updated",
		{ type: "webhook", id },
		{
			before: { secret_version: hook.secretVersion },
			after: { secret_version: version },
		},
	);
	return secret;
}

/** Switches webhook `id` on or off; on again starts its count of failures afresh. */
export async function setWebhookActive(
	scope: OrganisationScope,
	actorId: string,
	id: string,
	active: boolean,
): Promise<boolean> {
	const [changed] = await scope.webhooks.update(
		active ? { active, failures: 0 } : { active },
		(w) => and(eq(w.id, id), eq(w.active, !active)),
	);
	if (!changed) return false;
	await record(
		scope,
		actorId,
		"webhook.updated",
		{ type: "webhook", id },
		{
			before: { active: !active },
			after: { active },
		},
	);
	return true;
}

/** Deletes webhook `id` and its deliveries. */
export async function deleteWebhook(
	scope: OrganisationScope,
	actorId: string,
	id: string,
): Promise<boolean> {
	const [hook] = await scope.webhooks.select((w) => eq(w.id, id), { limit: 1 });
	if (!hook) return false;
	await scope.batch([
		scope.webhookDeliveries.statements.delete((d) => eq(d.webhookId, id)),
		scope.webhooks.statements.delete((w) => eq(w.id, id)),
	]);
	await record(
		scope,
		actorId,
		"webhook.deleted",
		{ type: "webhook", id },
		{
			before: { url: hook.url },
		},
	);
	return true;
}

/** Queues a `ping` to webhook `id` and tries it at once. False when there is no such webhook. */
export async function sendTest(
	scope: OrganisationScope,
	id: string,
	now: number,
	send: Send = fetch,
): Promise<boolean> {
	const [hook] = await scope.webhooks.select((w) => eq(w.id, id), { limit: 1 });
	if (!hook) return false;
	const deliveryId = uuidv7(now);
	await scope.webhookDeliveries.insert({
		id: deliveryId,
		webhookId: id,
		event: "ping",
		activityId: null,
		payload: JSON.stringify({
			id: deliveryId,
			event: "ping",
			created_at: new Date(now).toISOString(),
			data: { webhook_id: id },
		}),
		nextAttemptAt: new Date(now),
	});
	await deliverDue(scope, now, send, [deliveryId]);
	return true;
}

// ── The dispatcher ───────────────────────────────────────────────────────────

/** How a delivery is posted: `fetch`, or a stand-in in a test. */
export type Send = (request: Request) => Promise<Response>;

export interface Dispatch {
	/** The organisations to work for; all those with work when absent. */
	organisations?: readonly string[];
	/** The clock, in milliseconds. */
	now: number;
	send?: Send;
}

/**
 * One run: for each organisation, queues a delivery for every new activity
 * record an active webhook hears about, then makes every attempt that is due.
 * It never throws: a failure is logged, and the next run takes it up.
 */
export async function dispatchWebhooks({ organisations, now, send = fetch }: Dispatch) {
	try {
		const ids =
			organisations ??
			(await organisationsWithWebhooks(env.DB, new Date(now), ORGANISATIONS_PER_RUN));
		for (const organisationId of ids) {
			const scope = organisationScope(env.DB, organisationId);
			await queueNew(scope, now);
			await deliverDue(scope, now, send);
		}
	} catch (error) {
		console.error(
			`webhooks: dispatch failed with ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}

/** The webhook's maker as an API token with what the webhook may read: what its deliveries hold. */
function readerOf(caller: Caller, includeDescriptions: boolean): TokenCaller {
	return {
		...caller,
		tokenId: "",
		scopes: new Set(includeDescriptions ? ["time:read", "descriptions:read"] : ["time:read"]),
	};
}

interface ActivityRow {
	id: string;
	actorId: string | null;
	source: string;
	action: string;
	subjectType: string;
	subjectId: string;
	ownerId: string | null;
	summary: ActivitySummary;
	createdAt: Date;
}

/**
 * What a delivery of `activity` holds for `reader`, or null when they may not
 * see it: the event, who did it and from where, the fields that changed (with
 * a description only marked as changed, as the activity log keeps it), and the
 * subject as the API shows it now.
 */
async function bodyOf(reader: TokenCaller, activity: ActivityRow, deliveryId: string, now: number) {
	const owner = activity.ownerId;
	const kind = eventOf(activity.action);
	let data: Record<string, unknown> | null = { id: activity.subjectId };
	switch (kind) {
		case "time_entry":
			if (owner === null || !maySeeTimeOf(reader.access, owner)) return null;
			data = (await entryAsApiShows(reader, activity.subjectId, now)) ?? {
				id: activity.subjectId,
				deleted: true,
			};
			break;
		case "period": {
			if (owner === null || !maySeeTimeOf(reader.access, owner)) return null;
			const [period] = await reader.scope.periods.select((p) => eq(p.id, activity.subjectId), {
				limit: 1,
			});
			data = period
				? {
						id: period.id,
						user_id: period.userId,
						starts_on: period.startsOn,
						ends_on: period.endsOn,
						status: period.status,
					}
				: data;
			break;
		}
		case "expense": {
			if (owner === null || !maySeeExpensesOf(reader.access, owner)) return null;
			const [expense] = await reader.scope.expenses.select((x) => eq(x.id, activity.subjectId), {
				limit: 1,
			});
			data = expense
				? {
						id: expense.id,
						user_id: expense.userId,
						project_id: expense.projectId,
						spent_on: expense.spentOn,
						amount_minor: expense.amountMinor,
						currency: expense.currency,
						billable: expense.billable,
						...(reader.scopes.has("descriptions:read") ? { notes: expense.notes } : {}),
					}
				: { id: activity.subjectId, deleted: true };
			break;
		}
		case "invoice":
		case "payment": {
			if (!mayInvoice(reader.role)) return null;
			if (kind === "invoice") {
				const [invoice] = await reader.scope.invoices.select((i) => eq(i.id, activity.subjectId), {
					limit: 1,
				});
				data = invoice
					? {
							id: invoice.id,
							number: invoice.number,
							client_id: invoice.clientId,
							status: invoice.status,
							currency: invoice.currency,
							total_minor: invoice.totalMinor,
							issued_on: invoice.issuedOn,
							due_on: invoice.dueOn,
						}
					: { id: activity.subjectId, deleted: true };
			} else {
				const [payment] = await reader.scope.payments.select((p) => eq(p.id, activity.subjectId), {
					limit: 1,
				});
				data = payment
					? {
							id: payment.id,
							invoice_id: payment.invoiceId,
							amount_minor: payment.amountMinor,
							paid_on: payment.paidOn,
						}
					: { id: activity.subjectId, deleted: true };
			}
			break;
		}
		default:
			return null;
	}
	const actor =
		activity.actorId === null
			? null
			: ((
					await drizzle(env.DB)
						.select({ id: users.id, name: users.name })
						.from(users)
						.where(eq(users.id, activity.actorId))
						.limit(1)
				)[0] ?? { id: activity.actorId, name: null });
	return JSON.stringify({
		id: deliveryId,
		event: activity.action,
		created_at: activity.createdAt.toISOString(),
		source: activity.source,
		actor,
		subject: { type: activity.subjectType, id: activity.subjectId },
		changes: activity.summary,
		data,
	});
}

/** Queues the deliveries of the activity each active webhook has not yet been considered for. */
async function queueNew(scope: OrganisationScope, now: number) {
	const hooks = await scope.webhooks.select((w) => eq(w.active, true));
	for (const hook of hooks) {
		const after = hook.cursor === null ? null : Number(hook.cursor);
		const activity = await activityAfter(
			env.DB,
			scope.organisationId,
			after,
			hook.createdAt,
			RECORDS_PER_WEBHOOK,
		);
		const last = activity.at(-1);
		if (!last) continue;
		const maker = await callerOf(scope.organisationId, hook.createdBy);
		const reader = maker ? readerOf(maker, hook.includeDescriptions) : null;
		const deliveries = [];
		for (const row of activity) {
			const kind = eventOf(row.action);
			if (reader === null || kind === null || !hook.events.includes(kind)) continue;
			const id = uuidv7(now);
			const payload = await bodyOf(reader, row, id, now);
			if (payload === null) continue;
			deliveries.push({
				id,
				webhookId: hook.id,
				event: row.action,
				activityId: row.id,
				payload,
				nextAttemptAt: new Date(now),
			});
		}
		// The deliveries and the new cursor go together: a run that loses a race
		// to another queues nothing twice, as the second batch fails whole.
		const moveCursor = scope.webhooks.statements.update({ cursor: String(last.row) }, (w) =>
			and(eq(w.id, hook.id), hook.cursor === null ? isNull(w.cursor) : eq(w.cursor, hook.cursor)),
		);
		try {
			if (deliveries.length === 0) await moveCursor.query;
			else await scope.batch([moveCursor, scope.webhookDeliveries.statements.insert(deliveries)]);
		} catch {
			// Another run queued them.
		}
	}
}

/** Posts every delivery that is due, or those named, and notes what came of each. */
async function deliverDue(scope: OrganisationScope, now: number, send: Send, only?: string[]) {
	const due = await scope.webhookDeliveries.select(
		(d) =>
			and(
				eq(d.status, "pending"),
				only
					? inArray(d.id, only)
					: or(isNull(d.nextAttemptAt), lte(d.nextAttemptAt, new Date(now))),
			),
		{ orderBy: (d) => [d.nextAttemptAt, d.id], limit: DELIVERIES_PER_ORGANISATION },
	);
	if (due.length === 0) return;
	const hooks = await scope.webhooks.select((w) =>
		inArray(w.id, [...new Set(due.map((d) => d.webhookId))]),
	);
	const hookById = new Map(hooks.map((hook) => [hook.id, hook]));
	for (const delivery of due) {
		const hook = hookById.get(delivery.webhookId);
		// A webhook switched off keeps its deliveries until it is on again; a test is sent regardless.
		if (!hook || (!hook.active && delivery.event !== "ping")) continue;
		const outcome = await attempt(hook, delivery, now, send);
		const attempts = delivery.attempts + 1;
		const delivered = outcome.status !== null && outcome.status >= 200 && outcome.status < 300;
		const exhausted = !delivered && attempts >= MAX_ATTEMPTS;
		const wait = BACKOFF_MINUTES[attempts - 1];
		await scope.webhookDeliveries.update(
			{
				attempts,
				status: delivered ? "delivered" : exhausted ? "failed" : "pending",
				lastStatus: outcome.status,
				lastError: outcome.error,
				deliveredAt: delivered ? new Date(now) : null,
				nextAttemptAt:
					delivered || exhausted || wait === undefined ? null : new Date(now + wait * 60_000),
			},
			(d) => eq(d.id, delivery.id),
		);
		if (delivery.event === "ping" && !delivered) {
			// A test that fails is not tried again and counts against nothing.
			await scope.webhookDeliveries.update({ status: "failed", nextAttemptAt: null }, (d) =>
				eq(d.id, delivery.id),
			);
		}
		const failures = delivered ? 0 : exhausted ? hook.failures + 1 : hook.failures;
		const switchOff = exhausted && failures >= SWITCH_OFF_AFTER && hook.active;
		await scope.webhooks.update(
			{
				lastStatus: outcome.status,
				...(delivered ? { lastDeliveredAt: new Date(now) } : {}),
				failures,
				...(switchOff ? { active: false } : {}),
			},
			(w) => eq(w.id, hook.id),
		);
		hook.failures = failures;
		if (switchOff) {
			hook.active = false;
			await record(
				scope,
				null,
				"webhook.updated",
				{ type: "webhook", id: hook.id },
				{
					before: { active: true },
					after: { active: false },
				},
				"system",
			);
			await tellMaker(scope, hook.createdBy, hook.url);
		}
	}
}

interface Attempted {
	/** The receiver's status, or null when none answered in time. */
	status: number | null;
	error: "timeout" | "network" | null;
}

async function attempt(
	hook: { id: string; url: string; secretVersion: number },
	delivery: { id: string; event: string; payload: string },
	now: number,
	send: Send,
): Promise<Attempted> {
	const secret = await signingSecret(hook.id, hook.secretVersion);
	const signature = await signWebhook(secret, Math.floor(now / 1000), delivery.payload);
	try {
		const response = await send(
			new Request(hook.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "Timesifier-Webhooks/1",
					[SIGNATURE_HEADER]: signature,
					"Timesifier-Event": delivery.event,
					"Timesifier-Delivery": delivery.id,
				},
				body: delivery.payload,
				redirect: "manual",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			}),
		);
		await response.body?.cancel();
		return { status: response.status, error: null };
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return { status: null, error: timedOut ? "timeout" : "network" };
	}
}

/** Tells the webhook's maker by email that it was switched off, and where to switch it on. */
async function tellMaker(scope: OrganisationScope, makerId: string, url: string) {
	const [maker] = await drizzle(env.DB)
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, makerId))
		.limit(1);
	const caller = await callerOf(scope.organisationId, makerId);
	if (!maker || !caller) return;
	const host = setting(env, "APP_HOST");
	const link = host
		? `https://${host}${destinationPath(caller.organisation.slug, "integrations")}`
		: null;
	const message = compose(
		{
			subject: "A webhook was switched off",
			heading: "A webhook was switched off",
			parts: [
				`Timesifier stopped sending events to ${url} after ${SWITCH_OFF_AFTER} deliveries in a row failed. Nothing more is sent until it is switched on again on Integrations.`,
				...(link ? [{ action: "Open Integrations", link }] : []),
			],
			reason: `You are getting this because you added this webhook in ${caller.organisation.name}.`,
		},
		await getPlatformBrand(env),
	);
	await sendEmail({ to: maker.email, ...message });
}
