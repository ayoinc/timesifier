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
 * The three tables carry the fields of Better Auth's `user`, `organization`
 * and `member` models so that TS-008 can adopt them by mapping names.
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
