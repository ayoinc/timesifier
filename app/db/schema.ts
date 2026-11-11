/**
 * The database schema. `pnpm db:generate` turns a change here into a SQL
 * migration in `migrations/`.
 *
 * Outside `app/db/`, import from `~/db`, never from this file: tables that
 * carry an `organisation_id` are reached only through `organisationScope`.
 *
 * Ids are UUID version 7 text; timestamps are integers holding milliseconds
 * since the Unix epoch (UTC). See docs/decisions.md entry 17.
 *
 * `users`, `organisations`, `memberships` and `invitations` carry the fields of
 * Better Auth's `user`, `organization`, `member` and `invitation` models. The
 * tables below `invitations` are Better Auth's own. `app/auth/` maps each table
 * to its model. The property names are the field names Better Auth reads and
 * writes, except that its `organizationId` is our `organisationId`; renaming a
 * property breaks sign-in, and `test/auth/schema.test.ts` says so.
 */
import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { uuidv7 } from "./uuidv7";

const id = () => text("id").primaryKey().$defaultFn(uuidv7);

const createdAt = () =>
	integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.$defaultFn(() => new Date());

const updatedAt = () =>
	integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.$defaultFn(() => new Date())
		.$onUpdateFn(() => new Date());

export const users = sqliteTable("users", {
	id: id(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
	image: text("image"),
	/**
	 * The person's IANA time zone, such as `Europe/London`, or null until it is
	 * set; while it is null their organisation's zone is used (decision 26).
	 */
	timeZone: text("time_zone"),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

export const organisations = sqliteTable("organisations", {
	id: id(),
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	logo: text("logo"),
	metadata: text("metadata"),
	/** The zone of a person who has not set their own: an IANA name, `UTC` until an owner or admin chooses (TS-048). */
	timeZone: text("time_zone").notNull().default("UTC"),
	/** The day a timesheet period starts on, as ISO counts it: 1 is Monday, 7 is Sunday. */
	weekStartsOn: integer("week_starts_on").notNull().default(1),
	/** Whether the Clients destination and the client field are shown. Turning it off deletes nothing. */
	clientsEnabled: integer("clients_enabled", { mode: "boolean" }).notNull().default(true),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

export const memberships = sqliteTable(
	"memberships",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role").notNull().default("member"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("memberships_organisation_id_user_id_unique").on(
			table.organisationId,
			table.userId,
		),
		index("memberships_user_id_idx").on(table.userId),
	],
);

/**
 * An offer of membership, sent to an email address. Its id is the secret in the
 * invitation link. `status` is `pending` until the invitation is accepted or
 * cancelled; a pending invitation stops working at `expiresAt`.
 */
export const invitations = sqliteTable(
	"invitations",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		role: text("role").notNull(),
		status: text("status").notNull().default("pending"),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		inviterId: text("inviter_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		index("invitations_organisation_id_idx").on(table.organisationId),
		index("invitations_email_idx").on(table.email),
	],
);

// The tables of the features under the navigation's headings (TS-053). Each
// carries an `organisation_id` and is reached through `organisationScope`.
// A reference from one of them to another is a pair of columns, the
// organisation and the row, so that the database itself refuses a project of
// one organisation pointing at a client of another, and so on. Each table
// therefore has a unique index on `(organisation_id, id)` for such a reference
// to name. Names are unique in an organisation by `name_key`: the name
// normalised (NFKC), trimmed and lower-cased in the Worker (`nameKey` in
// `app/lib/names.ts`), archived rows included, so a restore never clashes.

/** Whom an organisation's time is for. Archived, never deleted (TS-011b). */
export const clients = sqliteTable(
	"clients",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		nameKey: text("name_key").notNull(),
		/** Null while the client is active. */
		archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("clients_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("clients_organisation_id_name_key_unique").on(table.organisationId, table.nameKey),
	],
);

/**
 * What time is tracked against. Archived, never deleted, so an entry always has
 * its project (decision 25). A project has one client or none; the client is
 * of the same organisation, which the pair of columns makes the database hold.
 */
export const projects = sqliteTable(
	"projects",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		nameKey: text("name_key").notNull(),
		clientId: text("client_id"),
		/** Null while the project is active. */
		archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("projects_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("projects_organisation_id_name_key_unique").on(table.organisationId, table.nameKey),
		index("projects_organisation_id_client_id_idx").on(table.organisationId, table.clientId),
		foreignKey({
			name: "projects_client_fk",
			columns: [table.organisationId, table.clientId],
			foreignColumns: [clients.organisationId, clients.id],
		}),
	],
);

/**
 * A stretch of one person's time on one project. `endedAt` is null while the
 * timer runs, and a person has at most one running entry in an organisation:
 * the partial unique index holds it (decision 25). `userId` does not cascade:
 * a deleted account's entries still add up in the organisation's reports.
 */
export const timeEntries = sqliteTable(
	"time_entries",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		projectId: text("project_id").notNull(),
		/** What the time was for, at most 500 characters; null when none was given. */
		description: text("description"),
		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		endedAt: integer("ended_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("time_entries_one_running_per_person")
			.on(table.organisationId, table.userId)
			.where(sql`${table.endedAt} IS NULL`),
		index("time_entries_organisation_id_user_id_started_at_idx").on(
			table.organisationId,
			table.userId,
			table.startedAt,
		),
		index("time_entries_organisation_id_project_id_started_at_idx").on(
			table.organisationId,
			table.projectId,
			table.startedAt,
		),
		foreignKey({
			name: "time_entries_project_fk",
			columns: [table.organisationId, table.projectId],
			foreignColumns: [projects.organisationId, projects.id],
		}),
		check(
			"time_entries_ends_after_start",
			sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`,
		),
	],
);

/**
 * One person's timesheet period once it has been submitted: its days are
 * local dates (`YYYY-MM-DD`) in the person's time zone, both included. Before
 * a first submission a period has no row. `status` is where it stands now;
 * `periodEvents` holds every step that brought it there. A submitted or
 * approved period locks the entries that start on its days (`app/periods/`).
 */
export const periods = sqliteTable(
	"periods",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		startsOn: text("starts_on").notNull(),
		endsOn: text("ends_on").notNull(),
		/** `submitted`, `withdrawn`, `approved` or `returned`. */
		status: text("status").notNull(),
		submittedAt: integer("submitted_at", { mode: "timestamp_ms" }).notNull(),
		/** Who approved or returned it, and when; null until somebody has. */
		decidedBy: text("decided_by").references(() => users.id),
		decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
		/** The reason given with the last return or reopening, at most 500 characters. */
		comment: text("comment"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("periods_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("periods_organisation_id_user_id_starts_on_unique").on(
			table.organisationId,
			table.userId,
			table.startsOn,
		),
		index("periods_organisation_id_status_starts_on_idx").on(
			table.organisationId,
			table.status,
			table.startsOn,
		),
		check(
			"periods_status_known",
			sql`${table.status} IN ('submitted', 'withdrawn', 'approved', 'returned')`,
		),
		check("periods_ends_on_or_after_start", sql`${table.endsOn} >= ${table.startsOn}`),
	],
);

/**
 * Each step in a period's life, with who took it and when: submitted,
 * withdrawn, approved, returned, or reopened by an owner or admin (TS-046,
 * TS-047). Rows are only ever added.
 */
export const periodEvents = sqliteTable(
	"period_events",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		periodId: text("period_id").notNull(),
		/** `submitted`, `withdrawn`, `approved`, `returned` or `reopened`. */
		action: text("action").notNull(),
		actorId: text("actor_id")
			.notNull()
			.references(() => users.id),
		/** The comment given with a return or a reopening, at most 500 characters. */
		comment: text("comment"),
		createdAt: createdAt(),
	},
	(table) => [
		index("period_events_organisation_id_period_id_idx").on(table.organisationId, table.periodId),
		foreignKey({
			name: "period_events_period_fk",
			columns: [table.organisationId, table.periodId],
			foreignColumns: [periods.organisationId, periods.id],
		}).onDelete("cascade"),
		check(
			"period_events_action_known",
			sql`${table.action} IN ('submitted', 'withdrawn', 'approved', 'returned', 'reopened')`,
		),
	],
);

/** A group of an organisation's members, which managers look after (TS-038, decision 29). */
export const teams = sqliteTable(
	"teams",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		nameKey: text("name_key").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("teams_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("teams_organisation_id_name_key_unique").on(table.organisationId, table.nameKey),
	],
);

/**
 * A member of the organisation in one of its teams. `isManager` makes them the
 * team's manager: a role held for that team alone (TS-038). The person must be
 * a member of the organisation, which the reference to `memberships` holds;
 * when they leave it, their places in its teams go with their membership.
 */
export const teamMembers = sqliteTable(
	"team_members",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		teamId: text("team_id").notNull(),
		userId: text("user_id").notNull(),
		isManager: integer("is_manager", { mode: "boolean" }).notNull().default(false),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("team_members_team_id_user_id_unique").on(table.teamId, table.userId),
		index("team_members_organisation_id_user_id_idx").on(table.organisationId, table.userId),
		foreignKey({
			name: "team_members_team_fk",
			columns: [table.organisationId, table.teamId],
			foreignColumns: [teams.organisationId, teams.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "team_members_membership_fk",
			columns: [table.organisationId, table.userId],
			foreignColumns: [memberships.organisationId, memberships.userId],
		}).onDelete("cascade"),
	],
);

// Leave (TS-061). The kinds of leave, the requests for it, the organisation's
// public holidays and its working week. A new organisation is given the six
// kinds and a week of Monday to Friday, 7.5 hours a day, by the trigger
// `organisations_leave_defaults` in `migrations/0007_leave.sql`, which drizzle-kit
// cannot write; the same migration gave every organisation that already existed
// the same rows.

/**
 * A kind of leave in one organisation: one row for each of the six keys
 * (`app/leave/kinds.ts`). Owners and admins rename a kind, switch it off, set
 * its yearly allowance and whether its requests wait for a decision; they never
 * add or delete one. The allowance is in half days; null is no allowance, so
 * nothing is counted against it.
 */
export const leaveKinds = sqliteTable(
	"leave_kinds",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		/** `annual`, `sick`, `study`, `parental`, `unpaid` or `holiday`. Never changes. */
		key: text("key").notNull(),
		name: text("name").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		needsApproval: integer("needs_approval", { mode: "boolean" }).notNull().default(true),
		/** Half days a year, or null for none. */
		allowanceHalfDays: integer("allowance_half_days"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("leave_kinds_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("leave_kinds_organisation_id_key_unique").on(table.organisationId, table.key),
		check(
			"leave_kinds_key_known",
			sql`${table.key} IN ('annual', 'sick', 'study', 'parental', 'unpaid', 'holiday')`,
		),
		check(
			"leave_kinds_allowance_in_range",
			sql`${table.allowanceHalfDays} IS NULL OR ${table.allowanceHalfDays} BETWEEN 0 AND 730`,
		),
	],
);

/**
 * One person's request for leave: from a first to a last local day, both
 * included, in their time zone. `startsHalf` makes the first day a half day and
 * `endsHalf` the last; a request of one day is a half day by `startsHalf`
 * alone. The kind and the person are of the same organisation, which the pairs
 * of columns make the database hold; when the person leaves the organisation
 * their requests go with their membership.
 *
 * `status` is `pending` until it is decided or withdrawn; a request that needs
 * no decision is `approved` when it is made. `decidedBy` and `decidedAt` are who
 * approved, refused or cancelled it and when; `comment` is what they said, and
 * the reason given with a cancellation. `note` is the person's own.
 */
export const leaveRequests = sqliteTable(
	"leave_requests",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		userId: text("user_id").notNull(),
		kindId: text("kind_id").notNull(),
		startsOn: text("starts_on").notNull(),
		endsOn: text("ends_on").notNull(),
		startsHalf: integer("starts_half", { mode: "boolean" }).notNull().default(false),
		endsHalf: integer("ends_half", { mode: "boolean" }).notNull().default(false),
		/** `pending`, `approved`, `refused`, `withdrawn` or `cancelled`. */
		status: text("status").notNull(),
		note: text("note"),
		decidedBy: text("decided_by").references(() => users.id),
		decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
		comment: text("comment"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("leave_requests_organisation_id_id_unique").on(table.organisationId, table.id),
		index("leave_requests_organisation_id_user_id_starts_on_idx").on(
			table.organisationId,
			table.userId,
			table.startsOn,
		),
		index("leave_requests_organisation_id_status_starts_on_idx").on(
			table.organisationId,
			table.status,
			table.startsOn,
		),
		foreignKey({
			name: "leave_requests_kind_fk",
			columns: [table.organisationId, table.kindId],
			foreignColumns: [leaveKinds.organisationId, leaveKinds.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "leave_requests_membership_fk",
			columns: [table.organisationId, table.userId],
			foreignColumns: [memberships.organisationId, memberships.userId],
		}).onDelete("cascade"),
		check(
			"leave_requests_status_known",
			sql`${table.status} IN ('pending', 'approved', 'refused', 'withdrawn', 'cancelled')`,
		),
		check("leave_requests_ends_on_or_after_start", sql`${table.endsOn} >= ${table.startsOn}`),
		check(
			"leave_requests_one_half_on_one_day",
			sql`${table.endsOn} > ${table.startsOn} OR NOT ${table.endsHalf}`,
		),
	],
);

/** A day off for everyone in the organisation, such as a bank holiday. One a day. */
export const publicHolidays = sqliteTable(
	"public_holidays",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		/** The local date, `YYYY-MM-DD`: the same day in every person's zone. */
		day: text("day").notNull(),
		name: text("name").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("public_holidays_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("public_holidays_organisation_id_day_unique").on(table.organisationId, table.day),
	],
);

/**
 * The organisation's working week: for each day of the week as ISO counts it
 * (1 is Monday), the minutes a person is expected to work; 0 is not a working
 * day. Seven rows an organisation.
 */
export const workingDays = sqliteTable(
	"working_days",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		weekday: integer("weekday").notNull(),
		minutes: integer("minutes").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("working_days_organisation_id_weekday_unique").on(
			table.organisationId,
			table.weekday,
		),
		check("working_days_weekday_in_range", sql`${table.weekday} BETWEEN 1 AND 7`),
		check("working_days_minutes_in_range", sql`${table.minutes} BETWEEN 0 AND 1440`),
	],
);

/**
 * A signed-in browser. The token is the value the session cookie carries, signed.
 *
 * `activeOrganisationId` is a field Better Auth's organization plugin requires
 * and writes when a person creates or joins an organisation. Nothing reads it:
 * the organisation of a request always comes from the request itself
 * (docs/decisions.md entry 20). It is not a foreign key, so a value left behind
 * by a deleted organisation never stands in the way of the deletion.
 */
export const sessions = sqliteTable(
	"sessions",
	{
		id: id(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token: text("token").notNull().unique(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		activeOrganisationId: text("active_organisation_id"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [index("sessions_user_id_idx").on(table.userId)],
);

/**
 * A way of signing in that belongs to a user at an identity provider. Better
 * Auth requires the table; signing in with an emailed code writes nothing to it.
 */
export const accounts = sqliteTable(
	"accounts",
	{
		id: id(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
		refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
		scope: text("scope"),
		password: text("password"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [index("accounts_user_id_idx").on(table.userId)],
);

/**
 * Short-lived proofs: the hash of an emailed sign-in code with its attempt
 * count.
 */
export const verifications = sqliteTable(
	"verifications",
	{
		id: id(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [index("verifications_identifier_idx").on(table.identifier)],
);

/**
 * One counter per client address and sign-in path, for the rate limit.
 * `lastRequest` is a plain number of milliseconds since the Unix epoch, not a
 * date: Better Auth compares it with `Date.now()` inside its SQL statements.
 */
export const rateLimits = sqliteTable("rate_limits", {
	id: id(),
	key: text("key").notNull().unique(),
	count: integer("count").notNull(),
	lastRequest: integer("last_request").notNull(),
});
