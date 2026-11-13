import { env } from "cloudflare:workers";

import { uuidv7 } from "~/db";
import type { Mailbox } from "../auth/harness";
import { createOrganisation, seedMembership } from "../organisations/harness";
import { type Person, person } from "../pages/harness";
import { kindOf } from "../pages/leave-seed";

// An organisation of 150 people (TS-112): more than D1's 100 bound
// parameters a statement, so any list of people, projects or records that
// goes to D1 as one parameter a value fails here. Written straight to the
// database in batches; the pages and the API are then asked through the
// Worker. `research/corporate/scale-test.md` is the measurement behind it.

/** How many people Acme has, the owner, the admin and the manager among them. */
export const PEOPLE = 150;
/** How many of them the manager manages, in one team, themselves apart. */
export const MANAGED = 120;
/** A week long past, so its days are the same on any day and in any zone the tests run. */
export const WEEK = "2026-01-05";

export interface Crowd {
	acme: { id: string; slug: string };
	owner: Person;
	admin: Person;
	/** A member who manages the team "Many" of `MANAGED` other people. */
	manager: Person;
	/** The 147 who never sign in, in the order of their names: Person 001 to Person 147. */
	others: string[];
	/** Who the manager manages: the first `MANAGED` of `others`. */
	managed: string[];
	/** The team "Many" the manager manages. */
	team: string;
	/** One project for each of the 150 people, Project 001 to Project 150. */
	projects: string[];
}

/** Rows of one statement each, sent as one D1 batch. */
async function insertAll(sql: string, rows: unknown[][]): Promise<void> {
	if (rows.length === 0) return;
	await env.DB.batch(rows.map((values) => env.DB.prepare(sql).bind(...values)));
}

const number = (i: number) => String(i + 1).padStart(3, "0");

export async function seedCrowd(mailbox: Mailbox): Promise<Crowd> {
	const owner = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(owner.cookie, "Acme");
	const admin = await person(mailbox, "grace@example.com");
	const manager = await person(mailbox, "hedy@example.com");
	await seedMembership(acme.id, admin.user.id, "admin");
	await seedMembership(acme.id, manager.user.id, "member");
	const now = Date.now();

	const others = Array.from({ length: PEOPLE - 3 }, () => uuidv7());
	await insertAll(
		"insert into users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)",
		others.map((id, i) => [id, `Person ${number(i)}`, `person${number(i)}@example.com`, now, now]),
	);
	await insertAll(
		"insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values (?, ?, ?, 'member', ?, ?)",
		others.map((id) => [uuidv7(), acme.id, id, 0, now]),
	);

	const managed = others.slice(0, MANAGED);
	const team = uuidv7();
	await insertAll(
		"insert into teams (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Many', 'many', ?, ?)",
		[[team, acme.id, now, now]],
	);
	await insertAll(
		"insert into team_members (id, organisation_id, team_id, user_id, is_manager, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
		[
			...managed.map((id) => [uuidv7(), acme.id, team, id, 0, now, now]),
			[uuidv7(), acme.id, team, manager.user.id, 1, now, now],
		],
	);

	const projects = Array.from({ length: PEOPLE }, () => uuidv7());
	await insertAll(
		"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
		projects.map((id, i) => [
			id,
			acme.id,
			`Project ${number(i)}`,
			`project ${number(i)}`,
			now,
			now,
		]),
	);
	return { acme, owner, admin, manager, others, managed, team, projects };
}

/** Everybody in Acme, the three who sign in first. */
export function everyone(crowd: Crowd): string[] {
	return [crowd.owner.user.id, crowd.admin.user.id, crowd.manager.user.id, ...crowd.others];
}

/**
 * Each of the 147 others with a submitted week `WEEK`, an hour on each of
 * its working days on a project of their own, and a request for a day of
 * annual leave in December waiting for a decision: what Team, Approvals and
 * Time off list, and what the Approvals link counts.
 */
export async function seedWork(crowd: Crowd): Promise<void> {
	const { acme, others, projects } = crowd;
	const now = Date.now();
	await insertAll(
		"insert into periods (id, organisation_id, user_id, starts_on, ends_on, status, submitted_at, created_at, updated_at) values (?, ?, ?, ?, '2026-01-11', 'submitted', ?, ?, ?)",
		others.map((id) => [uuidv7(), acme.id, id, WEEK, now, now, now]),
	);
	const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"];
	await insertAll(
		"insert into time_entries (id, organisation_id, user_id, project_id, started_at, ended_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
		others.flatMap((id, i) =>
			days.map((day) => {
				const start = Date.parse(`${day}T10:00:00Z`);
				return [uuidv7(), acme.id, id, projects[i], start, start + 3_600_000, now, now];
			}),
		),
	);
	const annual = await kindOf(acme.id, "annual");
	await insertAll(
		"insert into leave_requests (id, organisation_id, user_id, kind_id, starts_on, ends_on, starts_half, ends_half, status, created_at, updated_at) values (?, ?, ?, ?, '2026-12-14', '2026-12-14', 0, 0, 'pending', ?, ?)",
		others.map((id) => [uuidv7(), acme.id, id, annual, now, now]),
	);
}
