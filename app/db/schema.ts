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
	type AnySQLiteColumn,
	check,
	foreignKey,
	index,
	integer,
	primaryKey,
	type SQLiteTableExtraConfigValue,
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
	/**
	 * Whether the person gets the newsletter (TS-099): off until they ask for it,
	 * on My account or as they sign up. Every newsletter carries a link that turns it off.
	 */
	newsletter: integer("newsletter", { mode: "boolean" }).notNull().default(false),
	/**
	 * Whether the person gets product announcements (TS-099): on for every
	 * account holder until they turn them off, from the link in any announcement or on My account.
	 */
	announcements: integer("announcements", { mode: "boolean" }).notNull().default(true),
	/**
	 * When a platform owner closed the account (TS-099), null while it is open.
	 * A closed account cannot sign in; restoring it sets this back to null.
	 */
	closedAt: integer("closed_at", { mode: "timestamp_ms" }),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

/**
 * An organisation. The columns from `currency` on are TS-064's, for the
 * business features. Each is nullable or has a default and carries no CHECK:
 * SQLite adds such a column in place, while a CHECK or a new reference would
 * rebuild the table, and the tables that refer to it. The Worker checks their
 * values instead.
 */
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
	/** The currency of money nobody has given another one: ISO 4217, three upper-case letters (B5, B10). */
	currency: text("currency").notNull().default("GBP"),
	/** The lock date (B22): a local date on and before which no entry, expense or leave changes. Null when there is none. */
	lockedThrough: text("locked_through"),
	/** The timesheet deadline (B22): `none`, `weekly` or `monthly`. */
	deadlineKind: text("deadline_kind").notNull().default("none"),
	/** The deadline's day: an ISO weekday (1 Monday to 7 Sunday) when weekly; a day of the month when monthly, where 31 is the month's last day. */
	deadlineDay: integer("deadline_day"),
	/** The deadline's time of day, `HH:MM`, in the organisation's zone. */
	deadlineTime: text("deadline_time"),
	/** How many days after each deadline the lock date moves up to it (B22). Null when auto-lock is off. */
	autoLockDays: integer("auto_lock_days"),
	/** Why the lock date was last set or moved back by hand: an owner's or admin's words, at most 200 characters (TS-065). Null when it has none, or when auto-lock set it. */
	lockReason: text("lock_reason"),
	/** Whether, when the lock date moves forward, every unsubmitted period up to it is submitted by the system (B22, TS-065). */
	autoSubmitAtLock: integer("auto_submit_at_lock", { mode: "boolean" }).notNull().default(false),
	/** The deadline auto-lock last moved the lock date up to, so each deadline locks once and a date moved back stays back (TS-065). */
	autoLockedThrough: text("auto_locked_through"),
	/** Whether non-billable time counts against hour budgets (B7). */
	budgetCountsNonBillable: integer("budget_counts_non_billable", { mode: "boolean" })
		.notNull()
		.default(true),
	/**
	 * TS-090's rule for time beyond a working day's expected hours, superseded
	 * by `overtimePolicy` (TS-095) and no longer read. A later migration, which
	 * ships alone, takes it away.
	 */
	overtimeRule: text("overtime_rule").notNull().default("free"),
	/** TS-090's rule for time on a day not worked, superseded by `nonWorkingDays` (TS-095) and no longer read. */
	weekendRule: text("weekend_rule").notNull().default("free"),
	/**
	 * Time beyond a day's expected hours (TS-095): `none`, not allowed;
	 * `allowed`; `approval`, only as far as approved overtime covers the day.
	 * Every organisation began at `none`. `app/leave/rules.ts` reads it.
	 */
	overtimePolicy: text("overtime_policy").notNull().default("none"),
	/** Time on a day the working week does not work (TS-095): `overtime`, counted as overtime, or `none`, not allowed. */
	nonWorkingDays: text("non_working_days").notNull().default("overtime"),
	/** The most overtime a person records on a day, in minutes; null for no cap (TS-095). */
	overtimeDayCapMinutes: integer("overtime_day_cap_minutes"),
	/** The most overtime a person records in one of the organisation's weeks, in minutes; null for no cap (TS-095). */
	overtimeWeekCapMinutes: integer("overtime_week_cap_minutes"),
	/** Leave asked for at shorter notice than its kind's (TS-090): `with-reason`, allowed with a reason, or `refused`. */
	shortNotice: text("short_notice").notNull().default("with-reason"),
	/**
	 * The organisation's logo (TS-100): the media type of the file stored in R2
	 * under `org/<id>/brand/logo`, one of PNG, JPEG, WebP or SVG; null when it
	 * has none. `app/brand/organisation-brand.server.ts` is the only reader.
	 */
	brandLogoType: text("brand_logo_type"),
	/**
	 * Whether a PNG drawn from an SVG or WebP logo is stored beside it, under
	 * `org/<id>/brand/logo.png`, for the places that need pixels a mail program
	 * or a PDF can show (TS-100).
	 */
	brandLogoRendition: integer("brand_logo_rendition", { mode: "boolean" }).notNull().default(false),
	/** When the logo was last uploaded, in milliseconds: part of its address, so a new logo is fetched afresh. */
	brandLogoVersion: integer("brand_logo_version"),
	/** The organisation's colour, `#rrggbb`, dark enough for white type on it (TS-100); null for none. */
	brandColour: text("brand_colour"),
	/**
	 * The organisation's plan (TS-099): `free`, `team` or `business`
	 * (`app/plans/plans.ts`). Set by a platform owner; nothing is paid yet.
	 */
	plan: text("plan").notNull().default("free"),
	/** How many people the plan holds; null for the plan's own number. */
	seats: integer("seats"),
	/** When a trial of `plan` ends; after it the organisation is on Free. Null when the plan is not a trial. */
	trialEndsAt: integer("trial_ends_at", { mode: "timestamp_ms" }),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

/**
 * The platform's brand (TS-100): one row, `id` always `platform`, holding what
 * every email and export says of Timesifier itself. Its text columns start at
 * today's values; an image column is null while the built-in image stands.
 * Images are PNGs as base64. `app/brand/platform-brand.server.ts` is the only
 * code that reads or writes it.
 */
export const platformBrand = sqliteTable("platform_brand", {
	id: text("id").primaryKey(),
	/** The display name every message is from. */
	senderName: text("sender_name").notNull(),
	/** Where a reply to a message goes; null for no Reply-To header. */
	replyTo: text("reply_to"),
	tagline: text("tagline").notNull(),
	/** The line at the foot of every message the platform sends in its own name. */
	emailFooter: text("email_footer").notNull(),
	/** The platform's colour, `#rrggbb`: the band at the top of its messages. */
	colour: text("colour").notNull(),
	/** The logo a message carries attached, a PNG; null for the built-in one. */
	logo: text("logo"),
	/** The mark for light grounds, a PNG; null for the built-in one. */
	markLight: text("mark_light"),
	/** The mark for dark grounds, a PNG; null for the built-in one. */
	markDark: text("mark_dark"),
	updatedAt: integer("updated_at"),
	/** The person who last changed it, by id; null while it holds the values it started with. */
	updatedBy: text("updated_by"),
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
		/**
		 * Whether the person works as a contractor rather than an employee (B15).
		 * Defaulted, without a CHECK, so the column is added in place: the table
		 * carries the last-owner triggers of migration 0004 and is not rebuilt.
		 */
		isContractor: integer("is_contractor", { mode: "boolean" }).notNull().default(false),
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

/**
 * Whom an organisation's time is for. Archived, never deleted (TS-011b).
 * `currency` (TS-064) is nullable and unchecked so that SQLite adds it in place.
 */
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
		/** The client's currency, ISO 4217 (B10). Null means the organisation's. */
		currency: text("currency"),
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
 *
 * The columns from `billingType` on are TS-064's: how the project bills (B5)
 * and its budget (B7). Each is nullable or has a default and carries no CHECK,
 * so SQLite adds it in place rather than rebuilding the table, which every
 * entry refers to. The Worker checks their values.
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
		/** `hourly`, `fixed_fee` or `non_billable` (B5). Non-billable makes every task non-billable. */
		billingType: text("billing_type").notNull().default("hourly"),
		/** Which rate prices an hourly project's time: `project`, `person` or `task` (B5). */
		rateMode: text("rate_mode").notNull().default("project"),
		/** A fixed-fee project's fee, in minor units of the project's currency. */
		feeMinor: integer("fee_minor"),
		/**
		 * The project's first and last local day, both included, or null when not
		 * set (B6). A fixed fee is spread evenly over them for profitability.
		 */
		startsOn: text("starts_on"),
		endsOn: text("ends_on"),
		/** The project's currency, ISO 4217. Null means the client's, then the organisation's. */
		currency: text("currency"),
		/**
		 * The budget (B7): `none`, `total_hours`, `task_hours`, `person_hours`,
		 * `total_fees` or `task_fees`. A per-task or per-person budget is held in
		 * `budgetLines`.
		 */
		budgetKind: text("budget_kind").notNull().default("none"),
		/** A whole-project budget: minutes for an hours budget, minor units for a fees budget. */
		budgetAmount: integer("budget_amount"),
		/** Whether the budget starts again each calendar month in the organisation's zone. */
		budgetResetsMonthly: integer("budget_resets_monthly", { mode: "boolean" })
			.notNull()
			.default(false),
		/** The percentage of the budget at which managers are told. Null means no alert. */
		budgetAlertPercent: integer("budget_alert_percent").default(80),
		/** Whether a person tracking to the project is warned once it is over budget. */
		budgetWarnMembers: integer("budget_warn_members", { mode: "boolean" }).notNull().default(false),
		/** Whether expenses count against a fees budget. */
		budgetIncludesExpenses: integer("budget_includes_expenses", { mode: "boolean" })
			.notNull()
			.default(false),
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
 *
 * TS-064 adds the entry's task (B4), whether it is billable (B4, B5) and the
 * import that brought it (B19). The new references are pairs of columns, so
 * the table is rebuilt by migration 0008. An entry is invoiced while an
 * `invoiceLineSources` row names it.
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
		/**
		 * The task, one of the project's (B4). Null for an entry made before tasks.
		 * `taskId`, `billable` and `importId` (TS-064) are added in place, with no
		 * reference of their own: a reference would make SQLite rebuild the table,
		 * which drops and renames it, and a migration that does so ships alone
		 * (`.github/workflows/ci.yml`, "migration check"). The Worker reads the
		 * task and the import through the organisation's scope before writing them.
		 */
		taskId: text("task_id"),
		/** Whether the time is billed (B4, B5), copied from the project's task when recorded. */
		billable: integer("billable", { mode: "boolean" }).notNull().default(false),
		/** The CSV import that created the entry (B19), so reverting it removes exactly its entries. */
		importId: text("import_id"),
		/**
		 * Whether the time is overtime: past the day's expected hours, as the
		 * organisation's rule allows (TS-095). Added in place, defaulted, so an
		 * entry made before it is regular time.
		 */
		overtime: integer("overtime", { mode: "boolean" }).notNull().default(false),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("time_entries_organisation_id_id_unique").on(table.organisationId, table.id),
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
		index("time_entries_organisation_id_task_id_idx").on(table.organisationId, table.taskId),
		index("time_entries_organisation_id_import_id_idx").on(table.organisationId, table.importId),
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
 * TS-047). Rows are only ever added. `actorId` is null for a period the
 * system submitted when the lock date moved up past it (TS-065).
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
		actorId: text("actor_id").references(() => users.id),
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
		/**
		 * Days of notice a request should give (TS-090): from the day it is made
		 * to its first day. 0 asks for none; sick leave and public holidays are
		 * never held to it. The migration sets each kind's start.
		 */
		noticeDays: integer("notice_days").notNull().default(0),
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
		/** Days from the day it was made, in the person's zone, to its first day (TS-090); negative for leave already begun. */
		noticeDays: integer("notice_days").notNull().default(0),
		/** Whether it gave less notice than its kind asked for when it was made (TS-090). */
		shortNotice: integer("short_notice", { mode: "boolean" }).notNull().default(false),
		/** Why it was asked for at short notice: one line, the person's own. */
		noticeReason: text("notice_reason"),
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
 * day. Seven rows an organisation. Replaced by work schedules (TS-097) and no
 * longer read: migration `0019_work_schedules` made each organisation's week
 * its default schedule. A later migration, which ships alone, takes it away.
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

// Work schedules (TS-097). An organisation's named schedules, each a run of
// dated versions: from its day, a version holds the weekdays worked, with a
// start, a finish and an unpaid break each, and its own overtime and weekend
// rules or none, when the organisation's apply. An assignment gives a
// schedule, from its day, to a person, a team, a role or the organisation;
// the most specific wins (`app/schedules/schedules.ts`). Every organisation is
// given "Standard" and "Long", Standard its default, by the trigger
// `organisations_schedule_defaults` in `migrations/0019_work_schedules.sql`.

/** A named work schedule. Archived, it is no longer offered; it is never deleted, as past days keep it. */
export const workSchedules = sqliteTable(
	"work_schedules",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		/** The name folded for comparison: two schedules of an organisation never share one. */
		nameKey: text("name_key").notNull(),
		archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("work_schedules_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("work_schedules_organisation_id_name_key_unique").on(
			table.organisationId,
			table.nameKey,
		),
	],
);

/**
 * A schedule as it is from `effective_from`, a local date, until its next
 * version. The first version of every schedule is from `0001-01-01`. Its
 * overtime rule, with its caps, applies when `overtime_policy` is set, else
 * the organisation's; likewise `non_working_days`.
 */
export const workScheduleVersions = sqliteTable(
	"work_schedule_versions",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		scheduleId: text("schedule_id").notNull(),
		effectiveFrom: text("effective_from").notNull(),
		overtimePolicy: text("overtime_policy"),
		overtimeDayCapMinutes: integer("overtime_day_cap_minutes"),
		overtimeWeekCapMinutes: integer("overtime_week_cap_minutes"),
		nonWorkingDays: text("non_working_days"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("work_schedule_versions_organisation_id_id_unique").on(
			table.organisationId,
			table.id,
		),
		uniqueIndex("work_schedule_versions_schedule_id_effective_from_unique").on(
			table.scheduleId,
			table.effectiveFrom,
		),
		foreignKey({
			name: "work_schedule_versions_schedule_fk",
			columns: [table.organisationId, table.scheduleId],
			foreignColumns: [workSchedules.organisationId, workSchedules.id],
		}).onDelete("cascade"),
		check(
			"work_schedule_versions_overtime_policy_known",
			sql`${table.overtimePolicy} IS NULL OR ${table.overtimePolicy} IN ('none', 'allowed', 'approval')`,
		),
		check(
			"work_schedule_versions_non_working_days_known",
			sql`${table.nonWorkingDays} IS NULL OR ${table.nonWorkingDays} IN ('overtime', 'none')`,
		),
	],
);

/** A weekday a version works: from `start_minute` to `finish_minute` after midnight, less an unpaid break. A weekday without a row is not worked. */
export const workScheduleDays = sqliteTable(
	"work_schedule_days",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		versionId: text("version_id").notNull(),
		weekday: integer("weekday").notNull(),
		startMinute: integer("start_minute").notNull(),
		finishMinute: integer("finish_minute").notNull(),
		breakMinutes: integer("break_minutes").notNull().default(0),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("work_schedule_days_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("work_schedule_days_version_id_weekday_unique").on(table.versionId, table.weekday),
		foreignKey({
			name: "work_schedule_days_version_fk",
			columns: [table.organisationId, table.versionId],
			foreignColumns: [workScheduleVersions.organisationId, workScheduleVersions.id],
		}).onDelete("cascade"),
		check("work_schedule_days_weekday_in_range", sql`${table.weekday} BETWEEN 1 AND 7`),
		check(
			"work_schedule_days_times_in_range",
			sql`${table.startMinute} >= 0 AND ${table.finishMinute} <= 1440 AND ${table.finishMinute} > ${table.startMinute}`,
		),
		check(
			"work_schedule_days_break_fits",
			sql`${table.breakMinutes} >= 0 AND ${table.breakMinutes} < ${table.finishMinute} - ${table.startMinute}`,
		),
	],
);

/**
 * A schedule given from `effective_from` to a person (`target_id` their user
 * id), a team (its id), a role (`owner`, `admin`, `finance`, `member`,
 * `manager` or `contractor`) or the organisation (`target_id` empty). A later
 * assignment to the same target replaces it from its day; one with no
 * schedule takes the target's away, so the next level applies. `source_kind`
 * says what made it: `manual`, an owner or admin, or later a contract
 * (TS-098), named by `source_id`.
 */
export const scheduleAssignments = sqliteTable(
	"schedule_assignments",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		scheduleId: text("schedule_id"),
		targetKind: text("target_kind").notNull(),
		targetId: text("target_id").notNull(),
		effectiveFrom: text("effective_from").notNull(),
		sourceKind: text("source_kind").notNull().default("manual"),
		sourceId: text("source_id"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("schedule_assignments_organisation_id_id_unique").on(
			table.organisationId,
			table.id,
		),
		uniqueIndex("schedule_assignments_target_effective_from_unique").on(
			table.organisationId,
			table.targetKind,
			table.targetId,
			table.effectiveFrom,
		),
		foreignKey({
			name: "schedule_assignments_schedule_fk",
			columns: [table.organisationId, table.scheduleId],
			foreignColumns: [workSchedules.organisationId, workSchedules.id],
		}),
		check(
			"schedule_assignments_target_kind_known",
			sql`${table.targetKind} IN ('person', 'team', 'role', 'organisation')`,
		),
		check(
			"schedule_assignments_organisation_has_schedule",
			sql`${table.targetKind} <> 'organisation' OR ${table.scheduleId} IS NOT NULL`,
		),
		check(
			"schedule_assignments_source_kind_known",
			sql`${table.sourceKind} IN ('manual', 'contract')`,
		),
	],
);

// The tables of the business features (TS-064): tasks, rates, budgets,
// expenses, invoices, estimates, the activity log and integrations. TS-064
// lays them down; the cards that follow it (named here by their numbers in
// `docs/research/harvest-b2b.md`, B4 to B22) fill them. They keep the rules of
// the TS-053 tables above: each row carries its `organisation_id`, has a unique
// index on `(organisation_id, id)`, and refers to another organisation-owned
// row through the pair of columns, so the database refuses a reference across
// organisations. A pair with a null in it is not checked, which is how an
// optional reference is left empty.
//
// Money is an integer count of the currency's minor units, beside an ISO 4217
// code on the row that owns it; a document's lines take the document's.
// Percentages are basis points (2000 is 20%), quantities thousandths
// (`quantityMilli`, 1500 is 1.5), local dates `YYYY-MM-DD` text, and hour
// budgets minutes. Totals are computed in `app/money/`, never by the database.

/** A CHECK that a column holds an ISO 4217 code: three upper-case letters. */
const isCurrencyCode = (column: AnySQLiteColumn) => sql`${column} GLOB '[A-Z][A-Z][A-Z]'`;

/**
 * A kind of work, from the organisation's list (B4). Archived, never deleted.
 * A `common` task is added to each new project; `billableByDefault` is what a
 * project that adds the task starts with.
 */
export const tasks = sqliteTable(
	"tasks",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		nameKey: text("name_key").notNull(),
		billableByDefault: integer("billable_by_default", { mode: "boolean" }).notNull().default(true),
		common: integer("common", { mode: "boolean" }).notNull().default(false),
		/** Null while the task is active. */
		archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("tasks_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("tasks_organisation_id_name_key_unique").on(table.organisationId, table.nameKey),
	],
);

/**
 * A task on one project's list, billable or not on that project (B4). The
 * task's rate on the project is a `rates` row naming both.
 */
export const projectTasks = sqliteTable(
	"project_tasks",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		projectId: text("project_id").notNull(),
		taskId: text("task_id").notNull(),
		billable: integer("billable", { mode: "boolean" }).notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("project_tasks_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("project_tasks_project_id_task_id_unique").on(table.projectId, table.taskId),
		index("project_tasks_organisation_id_task_id_idx").on(table.organisationId, table.taskId),
		foreignKey({
			name: "project_tasks_project_fk",
			columns: [table.organisationId, table.projectId],
			foreignColumns: [projects.organisationId, projects.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "project_tasks_task_fk",
			columns: [table.organisationId, table.taskId],
			foreignColumns: [tasks.organisationId, tasks.id],
		}).onDelete("cascade"),
	],
);

/**
 * A label for entries, projects and expenses, from the organisation's list
 * (seen in Harvest's project details and bulk actions, §16 of the research).
 * Archived, never deleted.
 */
export const tags = sqliteTable(
	"tags",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		nameKey: text("name_key").notNull(),
		/** Null while the tag is active. */
		archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("tags_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("tags_organisation_id_name_key_unique").on(table.organisationId, table.nameKey),
	],
);

/** A tag on a time entry. It goes with the entry or the tag. */
export const entryTags = sqliteTable(
	"entry_tags",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		timeEntryId: text("time_entry_id").notNull(),
		tagId: text("tag_id").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("entry_tags_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("entry_tags_time_entry_id_tag_id_unique").on(table.timeEntryId, table.tagId),
		index("entry_tags_organisation_id_tag_id_idx").on(table.organisationId, table.tagId),
		foreignKey({
			name: "entry_tags_time_entry_fk",
			columns: [table.organisationId, table.timeEntryId],
			foreignColumns: [timeEntries.organisationId, timeEntries.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "entry_tags_tag_fk",
			columns: [table.organisationId, table.tagId],
			foreignColumns: [tags.organisationId, tags.id],
		}).onDelete("cascade"),
	],
);

/** A tag on a project. It goes with the project or the tag. */
export const projectTags = sqliteTable(
	"project_tags",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		projectId: text("project_id").notNull(),
		tagId: text("tag_id").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("project_tags_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("project_tags_project_id_tag_id_unique").on(table.projectId, table.tagId),
		index("project_tags_organisation_id_tag_id_idx").on(table.organisationId, table.tagId),
		foreignKey({
			name: "project_tags_project_fk",
			columns: [table.organisationId, table.projectId],
			foreignColumns: [projects.organisationId, projects.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "project_tags_tag_fk",
			columns: [table.organisationId, table.tagId],
			foreignColumns: [tags.organisationId, tags.id],
		}).onDelete("cascade"),
	],
);

/** A tag on an expense. It goes with the expense or the tag. */
export const expenseTags = sqliteTable(
	"expense_tags",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		expenseId: text("expense_id").notNull(),
		tagId: text("tag_id").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("expense_tags_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("expense_tags_expense_id_tag_id_unique").on(table.expenseId, table.tagId),
		index("expense_tags_organisation_id_tag_id_idx").on(table.organisationId, table.tagId),
		foreignKey({
			name: "expense_tags_expense_fk",
			columns: [table.organisationId, table.expenseId],
			foreignColumns: [expenses.organisationId, expenses.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "expense_tags_tag_fk",
			columns: [table.organisationId, table.tagId],
			foreignColumns: [tags.organisationId, tags.id],
		}).onDelete("cascade"),
	],
);

/**
 * An hourly rate in force from a local date: `billable` (B5) or `cost` (B6).
 * Which ids are set gives its level: none is the organisation's default; a
 * person; a project; a person on a project; a task; a task on a project. A
 * person and a task are never set together (Harvest has no person-on-task
 * rate either). An entry is priced at the latest rate of its level whose
 * `effectiveFrom` is on or before the entry's own date (`app/rates/`), so a new
 * rate never re-prices earlier time. Rows are added, not changed.
 */
export const rates = sqliteTable(
	"rates",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		/** `billable` or `cost`. */
		kind: text("kind").notNull(),
		userId: text("user_id").references(() => users.id),
		projectId: text("project_id"),
		taskId: text("task_id"),
		/** Per hour, in minor units of `currency`. */
		amountMinor: integer("amount_minor").notNull(),
		currency: text("currency").notNull(),
		effectiveFrom: text("effective_from").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("rates_organisation_id_id_unique").on(table.organisationId, table.id),
		// One rate per level and date: an index for each level, holding only
		// that level's rows, since a unique index treats every null as different
		// from every other (and drizzle-kit cannot write an index on an expression).
		uniqueIndex("rates_organisation_default_unique")
			.on(table.organisationId, table.kind, table.effectiveFrom)
			.where(
				sql`${table.userId} IS NULL AND ${table.projectId} IS NULL AND ${table.taskId} IS NULL`,
			),
		uniqueIndex("rates_person_unique")
			.on(table.organisationId, table.kind, table.userId, table.effectiveFrom)
			.where(sql`${table.projectId} IS NULL AND ${table.taskId} IS NULL`),
		uniqueIndex("rates_project_unique")
			.on(table.organisationId, table.kind, table.projectId, table.effectiveFrom)
			.where(sql`${table.userId} IS NULL AND ${table.taskId} IS NULL`),
		uniqueIndex("rates_project_person_unique")
			.on(table.organisationId, table.kind, table.projectId, table.userId, table.effectiveFrom)
			.where(sql`${table.taskId} IS NULL`),
		uniqueIndex("rates_task_unique")
			.on(table.organisationId, table.kind, table.taskId, table.effectiveFrom)
			.where(sql`${table.userId} IS NULL AND ${table.projectId} IS NULL`),
		uniqueIndex("rates_project_task_unique")
			.on(table.organisationId, table.kind, table.projectId, table.taskId, table.effectiveFrom)
			.where(sql`${table.userId} IS NULL`),
		index("rates_organisation_id_project_id_idx").on(table.organisationId, table.projectId),
		foreignKey({
			name: "rates_project_fk",
			columns: [table.organisationId, table.projectId],
			foreignColumns: [projects.organisationId, projects.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "rates_task_fk",
			columns: [table.organisationId, table.taskId],
			foreignColumns: [tasks.organisationId, tasks.id],
		}).onDelete("cascade"),
		check("rates_kind_known", sql`${table.kind} IN ('billable', 'cost')`),
		check("rates_not_person_and_task", sql`${table.userId} IS NULL OR ${table.taskId} IS NULL`),
		check("rates_amount_not_negative", sql`${table.amountMinor} >= 0`),
		check("rates_currency_code", isCurrencyCode(table.currency)),
	],
);

/**
 * A project's budget for one task or one person (B7), for a project whose
 * `budgetKind` is per task or per person: minutes for hours, minor units of
 * the project's currency for fees. Exactly one of the task and the person.
 */
export const budgetLines = sqliteTable(
	"budget_lines",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		projectId: text("project_id").notNull(),
		taskId: text("task_id"),
		userId: text("user_id").references(() => users.id),
		amount: integer("amount").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("budget_lines_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("budget_lines_project_id_task_id_unique").on(table.projectId, table.taskId),
		uniqueIndex("budget_lines_project_id_user_id_unique").on(table.projectId, table.userId),
		index("budget_lines_organisation_id_project_id_idx").on(table.organisationId, table.projectId),
		foreignKey({
			name: "budget_lines_project_fk",
			columns: [table.organisationId, table.projectId],
			foreignColumns: [projects.organisationId, projects.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "budget_lines_task_fk",
			columns: [table.organisationId, table.taskId],
			foreignColumns: [tasks.organisationId, tasks.id],
		}).onDelete("cascade"),
		check(
			"budget_lines_task_or_person",
			sql`(${table.taskId} IS NULL) <> (${table.userId} IS NULL)`,
		),
		check("budget_lines_amount_not_negative", sql`${table.amount} >= 0`),
	],
);

/**
 * That a project's spending crossed a threshold in one budget period (B7).
 * The unique index makes the alert go out once per period and threshold, even
 * when two writes cross it at once.
 */
export const budgetAlerts = sqliteTable(
	"budget_alerts",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		projectId: text("project_id").notNull(),
		/** The local date the budget period starts on; the project's first day for a budget that never resets. */
		periodStartsOn: text("period_starts_on").notNull(),
		thresholdPercent: integer("threshold_percent").notNull(),
		sentAt: integer("sent_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		uniqueIndex("budget_alerts_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("budget_alerts_project_id_period_threshold_unique").on(
			table.projectId,
			table.periodStartsOn,
			table.thresholdPercent,
		),
		foreignKey({
			name: "budget_alerts_project_fk",
			columns: [table.organisationId, table.projectId],
			foreignColumns: [projects.organisationId, projects.id],
		}).onDelete("cascade"),
		check("budget_alerts_threshold_positive", sql`${table.thresholdPercent} > 0`),
	],
);

/**
 * A kind of expense, from the organisation's list (B9). Archived, never
 * deleted. A unit-priced category, such as mileage, has both a unit and a
 * price per unit, and its expenses are entered as a quantity.
 */
export const expenseCategories = sqliteTable(
	"expense_categories",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		nameKey: text("name_key").notNull(),
		/** What one unit is called, such as "mile". */
		unitName: text("unit_name"),
		/** The price of one unit, in minor units of the organisation's currency. */
		unitPriceMinor: integer("unit_price_minor"),
		/** Null while the category is active. */
		archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("expense_categories_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("expense_categories_organisation_id_name_key_unique").on(
			table.organisationId,
			table.nameKey,
		),
		check(
			"expense_categories_unit_with_price",
			sql`(${table.unitName} IS NULL) = (${table.unitPriceMinor} IS NULL)`,
		),
		check(
			"expense_categories_unit_price_not_negative",
			sql`${table.unitPriceMinor} IS NULL OR ${table.unitPriceMinor} >= 0`,
		),
	],
);

/**
 * The unit price of a unit-priced expense category from a local date on
 * (TS-070, B9). An expense takes the price in force on its `spent_on`: the
 * row with the latest `effective_from` on or before it, or the earliest row
 * for a day before them all. A price change is a new row, so expenses dated
 * before it keep the old price. The category's own `unit_price_minor` is the
 * price most recently set, for showing.
 */
export const expenseCategoryPrices = sqliteTable(
	"expense_category_prices",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		categoryId: text("category_id").notNull(),
		effectiveFrom: text("effective_from").notNull(),
		/** In minor units of the organisation's currency. */
		unitPriceMinor: integer("unit_price_minor").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("expense_category_prices_organisation_id_id_unique").on(
			table.organisationId,
			table.id,
		),
		uniqueIndex("expense_category_prices_category_id_effective_from_unique").on(
			table.organisationId,
			table.categoryId,
			table.effectiveFrom,
		),
		foreignKey({
			name: "expense_category_prices_category_fk",
			columns: [table.organisationId, table.categoryId],
			foreignColumns: [expenseCategories.organisationId, expenseCategories.id],
		}).onDelete("cascade"),
		check("expense_category_prices_not_negative", sql`${table.unitPriceMinor} >= 0`),
	],
);

/**
 * Money one person spent on a project (B9). A unit-priced expense keeps its
 * quantity and the unit price copied from the category when it was recorded,
 * so a later price change leaves it alone. The receipt is a file in R2 under
 * `org/<organisationId>/receipts/<expenseId>`. Whether an expense is locked is
 * derived, never stored: by the person's submitted or approved period, by the
 * organisation's `lockedThrough`, and by an `invoiceLineSources` row naming it.
 * `userId` does not cascade, as for entries.
 */
export const expenses = sqliteTable(
	"expenses",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		projectId: text("project_id").notNull(),
		categoryId: text("category_id").notNull(),
		spentOn: text("spent_on").notNull(),
		amountMinor: integer("amount_minor").notNull(),
		currency: text("currency").notNull(),
		/** The quantity of a unit-priced expense, in thousandths; null otherwise. */
		quantityMilli: integer("quantity_milli"),
		unitPriceMinor: integer("unit_price_minor"),
		billable: integer("billable", { mode: "boolean" }).notNull().default(false),
		/** Whether the person asks to be paid back. */
		reimbursable: integer("reimbursable", { mode: "boolean" }).notNull().default(false),
		/** At most 500 characters. */
		notes: text("notes"),
		receiptKey: text("receipt_key"),
		/** The receipt's file name as uploaded. */
		receiptName: text("receipt_name"),
		/** The receipt's media type: `application/pdf`, `image/png` or `image/jpeg`. */
		receiptType: text("receipt_type"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("expenses_organisation_id_id_unique").on(table.organisationId, table.id),
		index("expenses_organisation_id_user_id_spent_on_idx").on(
			table.organisationId,
			table.userId,
			table.spentOn,
		),
		index("expenses_organisation_id_project_id_spent_on_idx").on(
			table.organisationId,
			table.projectId,
			table.spentOn,
		),
		index("expenses_organisation_id_category_id_idx").on(table.organisationId, table.categoryId),
		foreignKey({
			name: "expenses_project_fk",
			columns: [table.organisationId, table.projectId],
			foreignColumns: [projects.organisationId, projects.id],
		}),
		foreignKey({
			name: "expenses_category_fk",
			columns: [table.organisationId, table.categoryId],
			foreignColumns: [expenseCategories.organisationId, expenseCategories.id],
		}),
		check("expenses_amount_not_negative", sql`${table.amountMinor} >= 0`),
		check("expenses_currency_code", isCurrencyCode(table.currency)),
		check(
			"expenses_quantity_with_unit_price",
			sql`(${table.quantityMilli} IS NULL) = (${table.unitPriceMinor} IS NULL)`,
		),
		check(
			"expenses_quantity_positive",
			sql`${table.quantityMilli} IS NULL OR ${table.quantityMilli} > 0`,
		),
		check(
			"expenses_unit_price_not_negative",
			sql`${table.unitPriceMinor} IS NULL OR ${table.unitPriceMinor} >= 0`,
		),
		check("expenses_notes_length", sql`${table.notes} IS NULL OR length(${table.notes}) <= 500`),
		check(
			"expenses_receipt_whole",
			sql`(${table.receiptKey} IS NULL) = (${table.receiptName} IS NULL) AND (${table.receiptKey} IS NULL) = (${table.receiptType} IS NULL)`,
		),
		check(
			"expenses_receipt_type_known",
			sql`${table.receiptType} IS NULL OR ${table.receiptType} IN ('application/pdf', 'image/png', 'image/jpeg')`,
		),
	],
);

/**
 * A tax an invoice line can carry (B11), such as UK VAT at 2000 basis points.
 * A compound tax is charged on the amount with the line's first tax added.
 * Archived, never deleted, since issued invoices name it.
 */
export const taxes = sqliteTable(
	"taxes",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		rateBasisPoints: integer("rate_basis_points").notNull(),
		compound: integer("compound", { mode: "boolean" }).notNull().default(false),
		/** Null while the tax is active. */
		archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("taxes_organisation_id_id_unique").on(table.organisationId, table.id),
		check(
			"taxes_rate_in_range",
			sql`${table.rateBasisPoints} >= 0 AND ${table.rateBasisPoints} <= 10000`,
		),
	],
);

/**
 * The organisation's invoicing details (B10, B11): one row per organisation,
 * made when an owner, admin or Finance first saves them. `nextInvoiceNumber`
 * and `nextEstimateNumber` are the sequences: a number is taken by raising
 * them in the same batch that writes the document, so it is never reused.
 */
export const invoiceSettings = sqliteTable(
	"invoice_settings",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		legalName: text("legal_name"),
		address: text("address"),
		/** A tax registration number, such as a VAT number. */
		taxNumber: text("tax_number"),
		paymentTermsDays: integer("payment_terms_days").notNull().default(30),
		defaultNotes: text("default_notes"),
		nextInvoiceNumber: integer("next_invoice_number").notNull().default(1),
		nextEstimateNumber: integer("next_estimate_number").notNull().default(1),
		/** Days after the due date of the first late reminder (B11). Null when reminders are off. */
		lateReminderAfterDays: integer("late_reminder_after_days"),
		/** Days between later reminders. Null for a single reminder. */
		lateReminderEveryDays: integer("late_reminder_every_days"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("invoice_settings_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("invoice_settings_organisation_id_unique").on(table.organisationId),
		check("invoice_settings_payment_terms_not_negative", sql`${table.paymentTermsDays} >= 0`),
		check(
			"invoice_settings_numbers_positive",
			sql`${table.nextInvoiceNumber} >= 1 AND ${table.nextEstimateNumber} >= 1`,
		),
		check(
			"invoice_settings_reminders_positive",
			sql`(${table.lateReminderAfterDays} IS NULL OR ${table.lateReminderAfterDays} >= 0) AND (${table.lateReminderEveryDays} IS NULL OR ${table.lateReminderEveryDays} >= 1)`,
		),
	],
);

/**
 * Who receives a client's invoices and estimates (B11, B12): its billing
 * contacts, each an address and, when given, a name. An address is held once
 * per client, compared without case. Removing a contact removes only the row.
 */
export const clientContacts = sqliteTable(
	"client_contacts",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		clientId: text("client_id").notNull(),
		/** The person's name, at most 120 characters; null when only the address is known. */
		name: text("name"),
		email: text("email").notNull(),
		/** The address in lower case, for the uniqueness check. */
		emailKey: text("email_key").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("client_contacts_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("client_contacts_client_email_unique").on(
			table.organisationId,
			table.clientId,
			table.emailKey,
		),
		foreignKey({
			name: "client_contacts_client_fk",
			columns: [table.organisationId, table.clientId],
			foreignColumns: [clients.organisationId, clients.id],
		}).onDelete("cascade"),
		check("client_contacts_email_length", sql`length(${table.email}) <= 254`),
		check(
			"client_contacts_name_length",
			sql`${table.name} IS NULL OR length(${table.name}) <= 120`,
		),
	],
);

/**
 * A bill to a client, in one currency (B10, B11). `number` is unique in the
 * organisation and never reused. A draft's lines change freely; once sent, an
 * invoice is only paid, written off or voided. The totals are written by
 * `app/money/` whenever the lines change: subtotal − discount + tax = total.
 * It may be a retainer's funds invoice, made from a recurring invoice, or
 * made from an accepted estimate.
 */
export const invoices = sqliteTable(
	"invoices",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		number: text("number").notNull(),
		clientId: text("client_id").notNull(),
		/** `draft`, `sent`, `partially_paid`, `paid` or `void`. */
		status: text("status").notNull().default("draft"),
		currency: text("currency").notNull(),
		issuedOn: text("issued_on").notNull(),
		dueOn: text("due_on").notNull(),
		poNumber: text("po_number"),
		subject: text("subject"),
		notes: text("notes"),
		discountBasisPoints: integer("discount_basis_points").notNull().default(0),
		subtotalMinor: integer("subtotal_minor").notNull().default(0),
		discountMinor: integer("discount_minor").notNull().default(0),
		taxMinor: integer("tax_minor").notNull().default(0),
		totalMinor: integer("total_minor").notNull().default(0),
		sentAt: integer("sent_at", { mode: "timestamp_ms" }),
		voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
		retainerId: text("retainer_id"),
		recurringInvoiceId: text("recurring_invoice_id"),
		estimateId: text("estimate_id"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("invoices_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("invoices_organisation_id_number_unique").on(table.organisationId, table.number),
		index("invoices_organisation_id_client_id_issued_on_idx").on(
			table.organisationId,
			table.clientId,
			table.issuedOn,
		),
		index("invoices_organisation_id_status_due_on_idx").on(
			table.organisationId,
			table.status,
			table.dueOn,
		),
		foreignKey({
			name: "invoices_client_fk",
			columns: [table.organisationId, table.clientId],
			foreignColumns: [clients.organisationId, clients.id],
		}),
		foreignKey({
			name: "invoices_retainer_fk",
			columns: [table.organisationId, table.retainerId],
			foreignColumns: [retainers.organisationId, retainers.id],
		}),
		foreignKey({
			name: "invoices_recurring_invoice_fk",
			columns: [table.organisationId, table.recurringInvoiceId],
			foreignColumns: [recurringInvoices.organisationId, recurringInvoices.id],
		}),
		foreignKey({
			name: "invoices_estimate_fk",
			columns: [table.organisationId, table.estimateId],
			foreignColumns: [estimates.organisationId, estimates.id],
		}),
		check(
			"invoices_status_known",
			sql`${table.status} IN ('draft', 'sent', 'partially_paid', 'paid', 'void')`,
		),
		check("invoices_currency_code", isCurrencyCode(table.currency)),
		check("invoices_due_on_or_after_issue", sql`${table.dueOn} >= ${table.issuedOn}`),
		check(
			"invoices_discount_in_range",
			sql`${table.discountBasisPoints} >= 0 AND ${table.discountBasisPoints} <= 10000 AND ${table.discountMinor} >= 0`,
		),
	],
);

/**
 * One line of an invoice (B10): hours, an expense, a fixed fee, or a line
 * typed by hand. Its money is in the invoice's currency. A line may be
 * negative, as a credit, so its amounts carry no sign CHECK. The entries and
 * expenses it bills are its `invoiceLineSources`; deleting the line, or its
 * draft, releases them.
 */
export const invoiceLines = sqliteTable(
	"invoice_lines",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		invoiceId: text("invoice_id").notNull(),
		/** The line's place on the invoice, from 0. */
		position: integer("position").notNull(),
		/** `time`, `expense`, `fixed` or `manual`. */
		kind: text("kind").notNull(),
		description: text("description").notNull(),
		projectId: text("project_id"),
		quantityMilli: integer("quantity_milli").notNull(),
		unitPriceMinor: integer("unit_price_minor").notNull(),
		amountMinor: integer("amount_minor").notNull(),
		taxId: text("tax_id"),
		secondTaxId: text("second_tax_id"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("invoice_lines_organisation_id_id_unique").on(table.organisationId, table.id),
		index("invoice_lines_organisation_id_invoice_id_position_idx").on(
			table.organisationId,
			table.invoiceId,
			table.position,
		),
		foreignKey({
			name: "invoice_lines_invoice_fk",
			columns: [table.organisationId, table.invoiceId],
			foreignColumns: [invoices.organisationId, invoices.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "invoice_lines_project_fk",
			columns: [table.organisationId, table.projectId],
			foreignColumns: [projects.organisationId, projects.id],
		}),
		foreignKey({
			name: "invoice_lines_tax_fk",
			columns: [table.organisationId, table.taxId],
			foreignColumns: [taxes.organisationId, taxes.id],
		}),
		foreignKey({
			name: "invoice_lines_second_tax_fk",
			columns: [table.organisationId, table.secondTaxId],
			foreignColumns: [taxes.organisationId, taxes.id],
		}),
		check("invoice_lines_kind_known", sql`${table.kind} IN ('time', 'expense', 'fixed', 'manual')`),
		check("invoice_lines_position_not_negative", sql`${table.position} >= 0`),
		check(
			"invoice_lines_second_tax_after_first",
			sql`${table.secondTaxId} IS NULL OR (${table.taxId} IS NOT NULL AND ${table.secondTaxId} <> ${table.taxId})`,
		),
	],
);

/**
 * A time entry or an expense billed by an invoice line (B10): exactly one of
 * the two. The unique indexes put an entry or expense on one line at most; a
 * row here makes it invoiced, and locked until the row goes. The row goes with
 * its line. An invoiced entry or expense cannot be deleted, since nothing
 * cascades from it.
 */
export const invoiceLineSources = sqliteTable(
	"invoice_line_sources",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		lineId: text("line_id").notNull(),
		timeEntryId: text("time_entry_id"),
		expenseId: text("expense_id"),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("invoice_line_sources_organisation_id_id_unique").on(
			table.organisationId,
			table.id,
		),
		uniqueIndex("invoice_line_sources_organisation_id_time_entry_id_unique").on(
			table.organisationId,
			table.timeEntryId,
		),
		uniqueIndex("invoice_line_sources_organisation_id_expense_id_unique").on(
			table.organisationId,
			table.expenseId,
		),
		index("invoice_line_sources_organisation_id_line_id_idx").on(
			table.organisationId,
			table.lineId,
		),
		foreignKey({
			name: "invoice_line_sources_line_fk",
			columns: [table.organisationId, table.lineId],
			foreignColumns: [invoiceLines.organisationId, invoiceLines.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "invoice_line_sources_time_entry_fk",
			columns: [table.organisationId, table.timeEntryId],
			foreignColumns: [timeEntries.organisationId, timeEntries.id],
		}),
		foreignKey({
			name: "invoice_line_sources_expense_fk",
			columns: [table.organisationId, table.expenseId],
			foreignColumns: [expenses.organisationId, expenses.id],
		}),
		check(
			"invoice_line_sources_entry_or_expense",
			sql`(${table.timeEntryId} IS NULL) <> (${table.expenseId} IS NULL)`,
		),
	],
);

/**
 * Money received against an invoice, or a part of it written off (B11), in the
 * invoice's currency. A write-off has no method. Payments do not go with their
 * invoice: an invoice with payments is voided, never deleted.
 */
export const payments = sqliteTable(
	"payments",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		invoiceId: text("invoice_id").notNull(),
		/** `payment` or `write_off`. */
		kind: text("kind").notNull(),
		amountMinor: integer("amount_minor").notNull(),
		paidOn: text("paid_on").notNull(),
		/** `bank_transfer`, `card`, `cash`, `cheque` or `other`; null for a write-off. */
		method: text("method"),
		note: text("note"),
		recordedBy: text("recorded_by")
			.notNull()
			.references(() => users.id),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("payments_organisation_id_id_unique").on(table.organisationId, table.id),
		index("payments_organisation_id_invoice_id_idx").on(table.organisationId, table.invoiceId),
		index("payments_organisation_id_paid_on_idx").on(table.organisationId, table.paidOn),
		foreignKey({
			name: "payments_invoice_fk",
			columns: [table.organisationId, table.invoiceId],
			foreignColumns: [invoices.organisationId, invoices.id],
		}),
		check("payments_kind_known", sql`${table.kind} IN ('payment', 'write_off')`),
		check("payments_amount_positive", sql`${table.amountMinor} > 0`),
		check(
			"payments_method_known",
			sql`${table.method} IS NULL OR (${table.kind} = 'payment' AND ${table.method} IN ('bank_transfer', 'card', 'cash', 'cheque', 'other'))`,
		),
	],
);

/**
 * A priced offer to a client (B12), numbered in the organisation's own
 * sequence. The client accepts or declines it; an accepted estimate becomes a
 * draft invoice, which `invoiceId` names. Its arithmetic is the invoice's.
 */
export const estimates = sqliteTable(
	"estimates",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		number: text("number").notNull(),
		clientId: text("client_id").notNull(),
		/** `draft`, `sent`, `accepted` or `declined`. */
		status: text("status").notNull().default("draft"),
		currency: text("currency").notNull(),
		issuedOn: text("issued_on").notNull(),
		poNumber: text("po_number"),
		subject: text("subject"),
		notes: text("notes"),
		discountBasisPoints: integer("discount_basis_points").notNull().default(0),
		subtotalMinor: integer("subtotal_minor").notNull().default(0),
		discountMinor: integer("discount_minor").notNull().default(0),
		taxMinor: integer("tax_minor").notNull().default(0),
		totalMinor: integer("total_minor").notNull().default(0),
		sentAt: integer("sent_at", { mode: "timestamp_ms" }),
		/** When the client accepted or declined it. */
		decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
		invoiceId: text("invoice_id"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	// The return type is written out because `invoices` and `estimates` name
	// each other; without it TypeScript would infer each table from the other.
	(table): SQLiteTableExtraConfigValue[] => [
		uniqueIndex("estimates_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("estimates_organisation_id_number_unique").on(table.organisationId, table.number),
		index("estimates_organisation_id_client_id_issued_on_idx").on(
			table.organisationId,
			table.clientId,
			table.issuedOn,
		),
		foreignKey({
			name: "estimates_client_fk",
			columns: [table.organisationId, table.clientId],
			foreignColumns: [clients.organisationId, clients.id],
		}),
		foreignKey({
			name: "estimates_invoice_fk",
			columns: [table.organisationId, table.invoiceId],
			foreignColumns: [invoices.organisationId, invoices.id],
		}),
		check(
			"estimates_status_known",
			sql`${table.status} IN ('draft', 'sent', 'accepted', 'declined')`,
		),
		check("estimates_currency_code", isCurrencyCode(table.currency)),
		check(
			"estimates_discount_in_range",
			sql`${table.discountBasisPoints} >= 0 AND ${table.discountBasisPoints} <= 10000 AND ${table.discountMinor} >= 0`,
		),
	],
);

/** One line of an estimate (B12), in the estimate's currency. It goes with its estimate. */
export const estimateLines = sqliteTable(
	"estimate_lines",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		estimateId: text("estimate_id").notNull(),
		/** The line's place on the estimate, from 0. */
		position: integer("position").notNull(),
		description: text("description").notNull(),
		quantityMilli: integer("quantity_milli").notNull(),
		unitPriceMinor: integer("unit_price_minor").notNull(),
		amountMinor: integer("amount_minor").notNull(),
		taxId: text("tax_id"),
		secondTaxId: text("second_tax_id"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("estimate_lines_organisation_id_id_unique").on(table.organisationId, table.id),
		index("estimate_lines_organisation_id_estimate_id_position_idx").on(
			table.organisationId,
			table.estimateId,
			table.position,
		),
		foreignKey({
			name: "estimate_lines_estimate_fk",
			columns: [table.organisationId, table.estimateId],
			foreignColumns: [estimates.organisationId, estimates.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "estimate_lines_tax_fk",
			columns: [table.organisationId, table.taxId],
			foreignColumns: [taxes.organisationId, taxes.id],
		}),
		foreignKey({
			name: "estimate_lines_second_tax_fk",
			columns: [table.organisationId, table.secondTaxId],
			foreignColumns: [taxes.organisationId, taxes.id],
		}),
		check("estimate_lines_position_not_negative", sql`${table.position} >= 0`),
		check(
			"estimate_lines_second_tax_after_first",
			sql`${table.secondTaxId} IS NULL OR (${table.taxId} IS NOT NULL AND ${table.secondTaxId} <> ${table.taxId})`,
		),
	],
);

/**
 * A template that makes an invoice for a client on a schedule (B13): monthly,
 * quarterly or yearly from `startsOn`, until `endsOn` or until it is stopped.
 * A day past the end of a short month becomes that month's last day. It makes
 * a draft, or sends the invoice when `sendAutomatically` is on.
 */
export const recurringInvoices = sqliteTable(
	"recurring_invoices",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		clientId: text("client_id").notNull(),
		/** `monthly`, `quarterly` or `yearly`. */
		frequency: text("frequency").notNull(),
		startsOn: text("starts_on").notNull(),
		/** The last day an invoice may be made on; null for no end. */
		endsOn: text("ends_on"),
		nextIssueOn: text("next_issue_on").notNull(),
		sendAutomatically: integer("send_automatically", { mode: "boolean" }).notNull().default(false),
		/** Whether each invoice also bills the client's uninvoiced time. */
		includeUninvoicedTime: integer("include_uninvoiced_time", { mode: "boolean" })
			.notNull()
			.default(false),
		currency: text("currency").notNull(),
		paymentTermsDays: integer("payment_terms_days").notNull().default(30),
		subject: text("subject"),
		notes: text("notes"),
		/** Null while the schedule runs. */
		stoppedAt: integer("stopped_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("recurring_invoices_organisation_id_id_unique").on(table.organisationId, table.id),
		// Read across organisations by the scheduled job that issues the day's invoices.
		index("recurring_invoices_next_issue_on_idx").on(table.nextIssueOn),
		index("recurring_invoices_organisation_id_client_id_idx").on(
			table.organisationId,
			table.clientId,
		),
		foreignKey({
			name: "recurring_invoices_client_fk",
			columns: [table.organisationId, table.clientId],
			foreignColumns: [clients.organisationId, clients.id],
		}),
		check(
			"recurring_invoices_frequency_known",
			sql`${table.frequency} IN ('monthly', 'quarterly', 'yearly')`,
		),
		check(
			"recurring_invoices_ends_on_or_after_start",
			sql`${table.endsOn} IS NULL OR ${table.endsOn} >= ${table.startsOn}`,
		),
		check("recurring_invoices_currency_code", isCurrencyCode(table.currency)),
		check("recurring_invoices_payment_terms_not_negative", sql`${table.paymentTermsDays} >= 0`),
	],
);

/** One line of a recurring invoice's template (B13). It goes with its template. */
export const recurringInvoiceLines = sqliteTable(
	"recurring_invoice_lines",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		recurringInvoiceId: text("recurring_invoice_id").notNull(),
		/** The line's place on the invoice, from 0. */
		position: integer("position").notNull(),
		description: text("description").notNull(),
		quantityMilli: integer("quantity_milli").notNull(),
		unitPriceMinor: integer("unit_price_minor").notNull(),
		taxId: text("tax_id"),
		secondTaxId: text("second_tax_id"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("recurring_invoice_lines_organisation_id_id_unique").on(
			table.organisationId,
			table.id,
		),
		index("recurring_invoice_lines_organisation_id_recurring_invoice_id_idx").on(
			table.organisationId,
			table.recurringInvoiceId,
			table.position,
		),
		foreignKey({
			name: "recurring_invoice_lines_recurring_invoice_fk",
			columns: [table.organisationId, table.recurringInvoiceId],
			foreignColumns: [recurringInvoices.organisationId, recurringInvoices.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "recurring_invoice_lines_tax_fk",
			columns: [table.organisationId, table.taxId],
			foreignColumns: [taxes.organisationId, taxes.id],
		}),
		foreignKey({
			name: "recurring_invoice_lines_second_tax_fk",
			columns: [table.organisationId, table.secondTaxId],
			foreignColumns: [taxes.organisationId, taxes.id],
		}),
		check("recurring_invoice_lines_position_not_negative", sql`${table.position} >= 0`),
		check(
			"recurring_invoice_lines_second_tax_after_first",
			sql`${table.secondTaxId} IS NULL OR (${table.taxId} IS NOT NULL AND ${table.secondTaxId} <> ${table.taxId})`,
		),
	],
);

/**
 * Money a client pays in advance (B13), for the client or for one of its
 * projects. A paid funds invoice adds to the balance and a time invoice may
 * draw on it; the balance never goes below 0. `retainerMovements` holds every
 * change.
 */
export const retainers = sqliteTable(
	"retainers",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		clientId: text("client_id").notNull(),
		projectId: text("project_id"),
		currency: text("currency").notNull(),
		balanceMinor: integer("balance_minor").notNull().default(0),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("retainers_organisation_id_id_unique").on(table.organisationId, table.id),
		// One retainer per client, or per client and project: one index for
		// each, as a unique index treats every null as different from every other.
		uniqueIndex("retainers_client_unique")
			.on(table.organisationId, table.clientId)
			.where(sql`${table.projectId} IS NULL`),
		uniqueIndex("retainers_client_project_unique").on(
			table.organisationId,
			table.clientId,
			table.projectId,
		),
		foreignKey({
			name: "retainers_client_fk",
			columns: [table.organisationId, table.clientId],
			foreignColumns: [clients.organisationId, clients.id],
		}),
		foreignKey({
			name: "retainers_project_fk",
			columns: [table.organisationId, table.projectId],
			foreignColumns: [projects.organisationId, projects.id],
		}),
		check("retainers_currency_code", isCurrencyCode(table.currency)),
		check("retainers_balance_not_negative", sql`${table.balanceMinor} >= 0`),
	],
);

/** A deposit into a retainer or a draw from it (B13), with the invoice that made it. Rows are only ever added. */
export const retainerMovements = sqliteTable(
	"retainer_movements",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		retainerId: text("retainer_id").notNull(),
		/** `deposit` or `draw`. */
		kind: text("kind").notNull(),
		amountMinor: integer("amount_minor").notNull(),
		invoiceId: text("invoice_id"),
		occurredOn: text("occurred_on").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("retainer_movements_organisation_id_id_unique").on(table.organisationId, table.id),
		index("retainer_movements_organisation_id_retainer_id_occurred_on_idx").on(
			table.organisationId,
			table.retainerId,
			table.occurredOn,
		),
		foreignKey({
			name: "retainer_movements_retainer_fk",
			columns: [table.organisationId, table.retainerId],
			foreignColumns: [retainers.organisationId, retainers.id],
		}),
		foreignKey({
			name: "retainer_movements_invoice_fk",
			columns: [table.organisationId, table.invoiceId],
			foreignColumns: [invoices.organisationId, invoices.id],
		}),
		check("retainer_movements_kind_known", sql`${table.kind} IN ('deposit', 'draw')`),
		check("retainer_movements_amount_positive", sql`${table.amountMinor} > 0`),
	],
);

/** A value an activity record keeps for a field: never free text a person wrote (B17). */
export type ActivityValue = string | number | boolean | null;

/**
 * What an activity record says changed: the fields' values before and after.
 * A created record has only `after`, a deleted one only `before`. A changed
 * description is recorded as a marker, such as `{ description: "changed" }`,
 * never its text.
 */
export interface ActivitySummary {
	before?: Record<string, ActivityValue>;
	after?: Record<string, ActivityValue>;
}

/**
 * One thing that happened in the organisation (B17): who did it (`actorId`,
 * null for the system), from where (`source`), what (`action`, such as
 * `time_entry.created`), to which row (`subjectType`, `subjectId`), and whose
 * record that row is (`ownerId`, such as the entry's person; null for
 * organisation-level things), which is what a manager's and a member's view of
 * the log is limited by. Kept 730 days. Rows are only ever added: migration
 * 0008 adds a trigger refusing an UPDATE, so `actorId` is not set to null when
 * an account goes. `subjectId` and `ownerId` are not references, so a record
 * outlives what it is about.
 */
export const activityRecords = sqliteTable(
	"activity_records",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		actorId: text("actor_id").references(() => users.id),
		/** `web`, `api`, `import` or `system`. */
		source: text("source").notNull().default("web"),
		action: text("action").notNull(),
		subjectType: text("subject_type").notNull(),
		subjectId: text("subject_id").notNull(),
		ownerId: text("owner_id"),
		summary: text("summary", { mode: "json" }).$type<ActivitySummary>().notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("activity_records_organisation_id_id_unique").on(table.organisationId, table.id),
		index("activity_records_organisation_id_created_at_idx").on(
			table.organisationId,
			table.createdAt,
		),
		index("activity_records_organisation_id_subject_idx").on(
			table.organisationId,
			table.subjectType,
			table.subjectId,
		),
		index("activity_records_organisation_id_owner_id_created_at_idx").on(
			table.organisationId,
			table.ownerId,
			table.createdAt,
		),
		check(
			"activity_records_source_known",
			sql`${table.source} IN ('web', 'api', 'import', 'system')`,
		),
	],
);

/**
 * A report view saved under a name by one member (B18): `query` is the
 * report's search string, rerun against the day's data when it is opened. It
 * goes with its owner's membership. A shared report is shown to the people in
 * `savedReportShares`, each seeing only the rows their own role allows.
 */
export const savedReports = sqliteTable(
	"saved_reports",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		ownerId: text("owner_id").notNull(),
		name: text("name").notNull(),
		query: text("query").notNull(),
		shared: integer("shared", { mode: "boolean" }).notNull().default(false),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("saved_reports_organisation_id_id_unique").on(table.organisationId, table.id),
		index("saved_reports_organisation_id_owner_id_idx").on(table.organisationId, table.ownerId),
		foreignKey({
			name: "saved_reports_owner_membership_fk",
			columns: [table.organisationId, table.ownerId],
			foreignColumns: [memberships.organisationId, memberships.userId],
		}).onDelete("cascade"),
	],
);

/** A member a saved report is shared with, to view or to edit (B18). It goes with the report or the membership. */
export const savedReportShares = sqliteTable(
	"saved_report_shares",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		reportId: text("report_id").notNull(),
		userId: text("user_id").notNull(),
		canEdit: integer("can_edit", { mode: "boolean" }).notNull().default(false),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("saved_report_shares_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("saved_report_shares_report_id_user_id_unique").on(table.reportId, table.userId),
		index("saved_report_shares_organisation_id_user_id_idx").on(table.organisationId, table.userId),
		foreignKey({
			name: "saved_report_shares_report_fk",
			columns: [table.organisationId, table.reportId],
			foreignColumns: [savedReports.organisationId, savedReports.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "saved_report_shares_membership_fk",
			columns: [table.organisationId, table.userId],
			foreignColumns: [memberships.organisationId, memberships.userId],
		}).onDelete("cascade"),
	],
);

/**
 * A token for the public API (B20). The token is shown once; only its keyed
 * hash is kept (`app/integrations/tokens.server.ts`), with its first eight
 * characters as `prefix` so a list can tell tokens apart. `scopes` is what it
 * may do.
 */
export const apiTokens = sqliteTable(
	"api_tokens",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		tokenHash: text("token_hash").notNull(),
		prefix: text("prefix").notNull(),
		scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id),
		lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
		/** Null for a token that does not expire. */
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
		/** Null until the token is revoked. */
		revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("api_tokens_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("api_tokens_token_hash_unique").on(table.tokenHash),
		check("api_tokens_prefix_length", sql`length(${table.prefix}) = 8`),
	],
);

/**
 * An address told about events in the organisation (B20), such as
 * `time_entry.created`. Its signing secret is never stored: it is derived from
 * the Worker's key, the webhook's id and `secretVersion`, and only its hash is
 * kept. `failures` counts the deliveries that failed in a row.
 */
export const webhooks = sqliteTable(
	"webhooks",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		url: text("url").notNull(),
		events: text("events", { mode: "json" }).$type<string[]>().notNull(),
		secretHash: text("secret_hash").notNull(),
		secretVersion: integer("secret_version").notNull().default(1),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id),
		active: integer("active", { mode: "boolean" }).notNull().default(true),
		lastDeliveredAt: integer("last_delivered_at", { mode: "timestamp_ms" }),
		/** The HTTP status of the last delivery. */
		lastStatus: integer("last_status"),
		failures: integer("failures").notNull().default(0),
		/**
		 * Whether a delivery about an entry carries its description (TS-087). Off
		 * unless chosen when the webhook is added: a description is a person's own
		 * words.
		 */
		includeDescriptions: integer("include_descriptions", { mode: "boolean" })
			.notNull()
			.default(false),
		/**
		 * The id of the last activity record the webhook was considered for
		 * (TS-087). Records are UUIDv7, so a later one has a greater id; the
		 * dispatcher reads those after it.
		 */
		cursor: text("cursor"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("webhooks_organisation_id_id_unique").on(table.organisationId, table.id),
		check("webhooks_secret_version_positive", sql`${table.secretVersion} >= 1`),
		check("webhooks_failures_not_negative", sql`${table.failures} >= 0`),
	],
);

/**
 * One event sent, or to be sent, to a webhook (TS-087): the body exactly as it
 * is posted, how many times it was tried, when it is tried next and what the
 * receiver last answered. `pending` until a 2xx answer makes it `delivered`;
 * `failed` once every attempt has been used. One per webhook and activity
 * record, so a dispatcher that runs twice sends nothing twice.
 */
export const webhookDeliveries = sqliteTable(
	"webhook_deliveries",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		webhookId: text("webhook_id").notNull(),
		/** The event, such as `time_entry.created`, or `ping` for a test delivery. */
		event: text("event").notNull(),
		/** The activity record it reports; null for a test delivery. */
		activityId: text("activity_id"),
		payload: text("payload").notNull(),
		/** `pending`, `delivered` or `failed`. */
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		/** When it is tried next; null once delivered or failed. */
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
		/** The receiver's HTTP status at the last attempt; null when none answered. */
		lastStatus: integer("last_status"),
		/** Why the last attempt failed without a status: `timeout` or `network`. */
		lastError: text("last_error"),
		deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("webhook_deliveries_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("webhook_deliveries_webhook_id_activity_id_unique").on(
			table.webhookId,
			table.activityId,
		),
		index("webhook_deliveries_status_next_attempt_at_idx").on(table.status, table.nextAttemptAt),
		index("webhook_deliveries_organisation_id_webhook_id_created_at_idx").on(
			table.organisationId,
			table.webhookId,
			table.createdAt,
		),
		foreignKey({
			name: "webhook_deliveries_webhook_fk",
			columns: [table.organisationId, table.webhookId],
			foreignColumns: [webhooks.organisationId, webhooks.id],
		}).onDelete("cascade"),
		check(
			"webhook_deliveries_status_known",
			sql`${table.status} IN ('pending', 'delivered', 'failed')`,
		),
		check("webhook_deliveries_attempts_not_negative", sql`${table.attempts} >= 0`),
	],
);

/**
 * One CSV import (B19): previewed first, then imported, and perhaps reverted,
 * which deletes exactly the entries whose `importId` names it.
 */
export const importJobs = sqliteTable(
	"import_jobs",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		/** `time`, `clients`, `projects` or `expenses`. */
		kind: text("kind").notNull(),
		/** `previewed`, `imported`, `reverted` or `failed`. */
		status: text("status").notNull().default("previewed"),
		fileName: text("file_name").notNull(),
		rowCount: integer("row_count").notNull().default(0),
		importedCount: integer("imported_count").notNull().default(0),
		skippedCount: integer("skipped_count").notNull().default(0),
		/**
		 * The uploaded file's text while the import is previewed (TS-076), so the
		 * mapping and the preview are worked out from the one file. Emptied once
		 * it is imported: the entries hold what it said.
		 */
		source: text("source"),
		/** Which column of the file holds each field, by the field's name. */
		mapping: text("mapping", { mode: "json" }).$type<Record<string, string>>(),
		/** The rows that were not imported, by line, with why; never their notes. */
		skipped: text("skipped", { mode: "json" }).$type<{ line: number; reason: string }[]>(),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id),
		importedAt: integer("imported_at", { mode: "timestamp_ms" }),
		revertedAt: integer("reverted_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("import_jobs_organisation_id_id_unique").on(table.organisationId, table.id),
		index("import_jobs_organisation_id_created_at_idx").on(table.organisationId, table.createdAt),
		check(
			"import_jobs_kind_known",
			sql`${table.kind} IN ('time', 'clients', 'projects', 'expenses')`,
		),
		check(
			"import_jobs_status_known",
			sql`${table.status} IN ('previewed', 'imported', 'reverted', 'failed')`,
		),
		check(
			"import_jobs_counts_not_negative",
			sql`${table.rowCount} >= 0 AND ${table.importedCount} >= 0 AND ${table.skippedCount} >= 0`,
		),
	],
);

/**
 * A secret calendar (ICS) address listing approved leave (B3): a person's
 * own, or a team's for its manager. Only the token's hash is kept; revoking it
 * makes the address answer 404. It goes with the membership or the team.
 */
export const calendarFeeds = sqliteTable(
	"calendar_feeds",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		userId: text("user_id").notNull(),
		/** `person` or `team`. */
		kind: text("kind").notNull(),
		teamId: text("team_id"),
		/** Whether a person's own feed carries their entries as well as their approved leave (TS-089). */
		includeEntries: integer("include_entries", { mode: "boolean" }).notNull().default(false),
		tokenHash: text("token_hash").notNull(),
		revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("calendar_feeds_organisation_id_id_unique").on(table.organisationId, table.id),
		uniqueIndex("calendar_feeds_token_hash_unique").on(table.tokenHash),
		index("calendar_feeds_organisation_id_user_id_idx").on(table.organisationId, table.userId),
		foreignKey({
			name: "calendar_feeds_membership_fk",
			columns: [table.organisationId, table.userId],
			foreignColumns: [memberships.organisationId, memberships.userId],
		}).onDelete("cascade"),
		foreignKey({
			name: "calendar_feeds_team_fk",
			columns: [table.organisationId, table.teamId],
			foreignColumns: [teams.organisationId, teams.id],
		}).onDelete("cascade"),
		check("calendar_feeds_kind_known", sql`${table.kind} IN ('person', 'team')`),
		check(
			"calendar_feeds_team_for_team_kind",
			sql`(${table.kind} = 'team') = (${table.teamId} IS NOT NULL)`,
		),
	],
);

/**
 * A request to work beyond what the organisation allows freely (TS-090):
 * `overtime`, more than a working day's expected hours, or `weekend`, time on
 * a day the working week does not work. It covers a first to a last local
 * day, both included, at up to `minutesPerDay` on each day it applies to. It
 * is decided as leave is: `status` and the columns of the decision mean what
 * they mean on `leave_requests`, and it goes with its person's membership.
 */
export const workRequests = sqliteTable(
	"work_requests",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		userId: text("user_id").notNull(),
		/** `overtime` or `weekend`. */
		kind: text("kind").notNull(),
		startsOn: text("starts_on").notNull(),
		endsOn: text("ends_on").notNull(),
		minutesPerDay: integer("minutes_per_day").notNull(),
		/** Why, in the person's words. */
		reason: text("reason"),
		/** `pending`, `approved`, `refused`, `withdrawn` or `cancelled`. */
		status: text("status").notNull(),
		decidedBy: text("decided_by").references(() => users.id),
		decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
		comment: text("comment"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("work_requests_organisation_id_id_unique").on(table.organisationId, table.id),
		index("work_requests_organisation_id_user_id_starts_on_idx").on(
			table.organisationId,
			table.userId,
			table.startsOn,
		),
		index("work_requests_organisation_id_status_starts_on_idx").on(
			table.organisationId,
			table.status,
			table.startsOn,
		),
		foreignKey({
			name: "work_requests_membership_fk",
			columns: [table.organisationId, table.userId],
			foreignColumns: [memberships.organisationId, memberships.userId],
		}).onDelete("cascade"),
		check("work_requests_kind_known", sql`${table.kind} IN ('overtime', 'weekend')`),
		check(
			"work_requests_status_known",
			sql`${table.status} IN ('pending', 'approved', 'refused', 'withdrawn', 'cancelled')`,
		),
		check("work_requests_ends_on_or_after_start", sql`${table.endsOn} >= ${table.startsOn}`),
		check("work_requests_minutes_in_range", sql`${table.minutesPerDay} BETWEEN 1 AND 1440`),
	],
);

// The platform console (TS-099): the layer above every organisation, open to
// the addresses in `PLATFORM_OWNERS` after a fresh emailed code. Its own
// tables hold no organisation's data; `support_grants` is the organisation's,
// and reached through `organisationScope`.

/**
 * A platform owner's step-up for one session: the code emailed to them, kept as
 * a keyed hash, and when it was proved. It goes with the session, so each new
 * session asks for a new code.
 */
export const platformStepUps = sqliteTable("platform_step_ups", {
	sessionId: text("session_id")
		.primaryKey()
		.references(() => sessions.id, { onDelete: "cascade" }),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	/** The waiting code, as a keyed hash; null once it is used or before one is sent. */
	codeHash: text("code_hash"),
	codeExpiresAt: integer("code_expires_at", { mode: "timestamp_ms" }),
	/** Wrong codes tried against the waiting code. */
	attempts: integer("attempts").notNull().default(0),
	/** Codes sent for this session. */
	sent: integer("sent").notNull().default(0),
	verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

/**
 * The platform's own log: every step a platform owner takes in the console,
 * with the reason they gave, and every use of support access. Never changed or
 * deleted by the application.
 */
export const platformEvents = sqliteTable(
	"platform_events",
	{
		id: id(),
		/** Who: a platform owner, or null for the system. */
		actorId: text("actor_id").references(() => users.id),
		action: text("action").notNull(),
		/** `account`, `organisation`, `mailing` or `console`. */
		subjectType: text("subject_type").notNull(),
		subjectId: text("subject_id"),
		reason: text("reason"),
		/** What the step was about, in a few named values: never an organisation's data. */
		detail: text("detail", { mode: "json" })
			.$type<Record<string, string | number | boolean | null>>()
			.notNull()
			.default(sql`'{}'`),
		createdAt: createdAt(),
	},
	(table) => [
		index("platform_events_created_at_idx").on(table.createdAt),
		index("platform_events_subject_idx").on(table.subjectType, table.subjectId),
	],
);

/**
 * Support access an organisation's owner granted the platform (TS-099): until
 * `expires_at`, or until revoked, a platform owner may read the organisation's
 * own data, and change nothing.
 */
export const supportGrants = sqliteTable(
	"support_grants",
	{
		id: id(),
		organisationId: text("organisation_id")
			.notNull()
			.references(() => organisations.id, { onDelete: "cascade" }),
		grantedBy: text("granted_by")
			.notNull()
			.references(() => users.id),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
		revokedBy: text("revoked_by").references(() => users.id),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("support_grants_organisation_id_id_unique").on(table.organisationId, table.id),
		index("support_grants_organisation_id_expires_at_idx").on(
			table.organisationId,
			table.expiresAt,
		),
	],
);

/** One sign-in: when, and the browser's kind in two words. Kept for 90 days. */
export const signIns = sqliteTable(
	"sign_ins",
	{
		id: id(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** Such as "Chrome on macOS"; never the address it came from. */
		device: text("device").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		index("sign_ins_user_id_created_at_idx").on(table.userId, table.createdAt),
		index("sign_ins_created_at_idx").on(table.createdAt),
	],
);

/**
 * A message to account holders (TS-099): a product announcement, to everyone
 * who has not turned them off, or the newsletter, to those who asked for it.
 */
export const mailings = sqliteTable(
	"mailings",
	{
		id: id(),
		/** `announcement` or `newsletter`. */
		kind: text("kind").notNull(),
		subject: text("subject").notNull(),
		body: text("body").notNull(),
		sentBy: text("sent_by").references(() => users.id),
		/** How many people it was addressed to when it was sent. */
		recipients: integer("recipients").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		check("mailings_kind_known", sql`${table.kind} IN ('announcement', 'newsletter')`),
		index("mailings_created_at_idx").on(table.createdAt),
	],
);

/**
 * One person's copy of a mailing, waiting until `sent_at`. The scheduled work
 * sends them a few at a time, within the day's cap.
 */
export const mailingDeliveries = sqliteTable(
	"mailing_deliveries",
	{
		mailingId: text("mailing_id")
			.notNull()
			.references(() => mailings.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** When it was sent, or skipped because the person had turned the mail off; null while waiting. */
		sentAt: integer("sent_at", { mode: "timestamp_ms" }),
		/** `sent` or `skipped`; null while waiting. */
		outcome: text("outcome"),
	},
	(table) => [
		primaryKey({ columns: [table.mailingId, table.userId] }),
		index("mailing_deliveries_sent_at_idx").on(table.sentAt),
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
