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
 * `users`, `organisations` and `memberships` carry the fields of Better Auth's
 * `user`, `organization` and `member` models. The tables below `memberships`
 * are Better Auth's own; `app/auth/auth.server.ts` maps each to its model.
 * The property names are the field names Better Auth reads and writes, so
 * renaming a property there breaks sign-in; `test/auth/schema.test.ts` says so.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

export const organisations = sqliteTable("organisations", {
	id: id(),
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	logo: text("logo"),
	metadata: text("metadata"),
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

/** A signed-in browser. The token is the value the session cookie carries, signed. */
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
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [index("sessions_user_id_idx").on(table.userId)],
);

/**
 * A way of signing in that belongs to a user at an identity provider. Better
 * Auth requires the table; email codes and passkeys write nothing to it.
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
 * count, and the challenge of a passkey ceremony in progress.
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

/** A passkey's public half. The private key never leaves the person's device. */
export const passkeys = sqliteTable(
	"passkeys",
	{
		id: id(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name"),
		publicKey: text("public_key").notNull(),
		credentialID: text("credential_id").notNull(),
		counter: integer("counter").notNull(),
		deviceType: text("device_type").notNull(),
		backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
		transports: text("transports"),
		aaguid: text("aaguid"),
		createdAt: createdAt(),
	},
	(table) => [
		index("passkeys_user_id_idx").on(table.userId),
		index("passkeys_credential_id_idx").on(table.credentialID),
	],
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
