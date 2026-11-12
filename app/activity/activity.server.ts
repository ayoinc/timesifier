import type { SQL } from "drizzle-orm";

import type { ActivitySummary, ActivityValue, OrganisationScope } from "~/db";

import type { ActivityAction, ActivitySource, SubjectType } from "./actions";

/**
 * The activity log (TS-064): one row for each change a person, the API, an
 * import or the system makes, saying who made it, to what, whose record it
 * is about, and what it was before and after. A write and its row go in the
 * same D1 batch where the write is batched (`recordStatement`), so neither
 * lands without the other; elsewhere the row is written once the change is.
 * Rows are never changed (a trigger refuses an UPDATE) and are kept for
 * `ACTIVITY_RETENTION_DAYS`.
 *
 * Free text a person typed is never copied into the log: a description, a
 * note or a comment that changed is recorded as the marker `"changed"`.
 */

/** How long a row is kept: two years (owner decision, TS-064). */
export const ACTIVITY_RETENTION_DAYS = 730;

const DAY = 24 * 60 * 60 * 1000;

/** The fields whose text is never recorded, only that it changed. */
export const REDACTED_FIELDS: readonly string[] = ["description", "notes", "comment"];

/** What a redacted field holds in a summary in place of its text. */
export const REDACTED = "changed";

/** What an action was taken on, and whose it is: the person an entry or period belongs to, null for the organisation's own things. */
export interface Subject {
	type: SubjectType;
	id: string;
	ownerId?: string | null;
}

/** A value a summary can be built from: a date is recorded as milliseconds; `undefined` is no value given. */
type Recordable = ActivityValue | Date | undefined;

function recordable(value: Recordable): ActivityValue | undefined {
	return value instanceof Date ? value.getTime() : value;
}

const hasText = (value: ActivityValue | undefined) => typeof value === "string" && value !== "";

/**
 * The fields among `fields` that differ between `before` and `after`, each
 * side holding its own value. `before` null is a thing created, `after` null
 * one deleted. A redacted field is recorded as `REDACTED` on the side that
 * stands now (after, or before for a deletion), and not at all when neither
 * side has text.
 */
export function changes<K extends string>(
	before: { readonly [F in NoInfer<K>]?: Recordable } | null,
	after: { readonly [F in NoInfer<K>]?: Recordable } | null,
	fields: readonly K[],
): ActivitySummary {
	const was: Record<string, ActivityValue> = {};
	const is: Record<string, ActivityValue> = {};
	for (const field of fields) {
		const old = before ? recordable(before[field]) : undefined;
		const now = after ? recordable(after[field]) : undefined;
		if (old === now) continue;
		if (REDACTED_FIELDS.includes(field)) {
			if (hasText(old) || hasText(now)) (after ? is : was)[field] = REDACTED;
			continue;
		}
		if (old !== undefined) was[field] = old;
		if (now !== undefined) is[field] = now;
	}
	const summary: ActivitySummary = {};
	if (Object.keys(was).length > 0) summary.before = was;
	if (Object.keys(is).length > 0) summary.after = is;
	return summary;
}

/** `side` with the text of every redacted field replaced by the marker. */
function redactSide(side: Record<string, ActivityValue> | undefined) {
	if (!side) return undefined;
	return Object.fromEntries(
		Object.entries(side).map(([field, value]) => [
			field,
			REDACTED_FIELDS.includes(field) && hasText(value) ? REDACTED : value,
		]),
	);
}

/** The summary as it is stored: a caller that built its own never stores free text either. */
function redact(summary: ActivitySummary): ActivitySummary {
	const stored: ActivitySummary = {};
	const before = redactSide(summary.before);
	const after = redactSide(summary.after);
	if (before) stored.before = before;
	if (after) stored.after = after;
	return stored;
}

/** The row that records `action`, with its summary redacted. */
function rowOf(
	actor: string | null,
	action: ActivityAction,
	subject: Subject,
	summary: ActivitySummary,
	source: ActivitySource,
) {
	return {
		actorId: actor,
		source,
		action,
		subjectType: subject.type,
		subjectId: subject.id,
		ownerId: subject.ownerId ?? null,
		summary: redact(summary),
	};
}

/**
 * The row recording `action`, built and not sent, for the `scope.batch` that
 * makes the change it records. `actor` is the person who acted, null for the
 * system.
 */
export function recordStatement(
	scope: OrganisationScope,
	actor: string | null,
	action: ActivityAction,
	subject: Subject,
	summary: ActivitySummary = {},
	source: ActivitySource = "web",
) {
	return scope.activityRecords.statements.insert(rowOf(actor, action, subject, summary, source));
}

/**
 * The row recording `action`, written only when `condition` holds as the
 * batch reaches it: for a change whose own statement may find nothing to
 * change (another request got there first), so the record lands exactly when
 * the change did.
 */
export function recordStatementWhen(
	scope: OrganisationScope,
	condition: SQL,
	actor: string | null,
	action: ActivityAction,
	subject: Subject,
	summary: ActivitySummary = {},
	source: ActivitySource = "web",
) {
	return scope.activityRecords.statements.insertWhen(
		rowOf(actor, action, subject, summary, source),
		condition,
	);
}

/** One record of a change made to many things at once. */
export interface Recorded {
	action: ActivityAction;
	subject: Subject;
	summary?: ActivitySummary;
}

/**
 * The rows recording `records`, as one statement, for the batch that makes
 * them (an import's rows). D1 binds at most 100 values to a statement, so a
 * caller sends at most 8 records to one.
 */
export function recordsStatement(
	scope: OrganisationScope,
	actor: string | null,
	records: readonly Recorded[],
	source: ActivitySource,
) {
	return scope.activityRecords.statements.insert(
		records.map((r) => rowOf(actor, r.action, r.subject, r.summary ?? {}, source)),
	);
}

/** Records `action` on its own, for a change that has already been made. */
export async function record(
	scope: OrganisationScope,
	actor: string | null,
	action: ActivityAction,
	subject: Subject,
	summary: ActivitySummary = {},
	source: ActivitySource = "web",
): Promise<void> {
	await scope.activityRecords.insert(rowOf(actor, action, subject, summary, source));
}

/** The instant before which a row is no longer kept, for a clean-up running at `now`. */
export function activityExpiry(now: Date): Date {
	return new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * DAY);
}

/**
 * Deletes the rows of every organisation older than `ACTIVITY_RETENTION_DAYS`
 * at `now`, and returns how many went. It is the one statement that crosses
 * organisations on purpose, so it is plain SQL rather than a scoped accessor.
 * TS-033's daily job runs it.
 */
export async function deleteExpiredActivity(database: D1Database, now: Date): Promise<number> {
	const result = await database
		.prepare("delete from activity_records where created_at < ?1")
		.bind(activityExpiry(now).getTime())
		.run();
	return result.meta.changes;
}
