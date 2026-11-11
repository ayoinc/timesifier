import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * Rows the Timesheet's browser tests start from, written straight into the
 * local database the server under test reads. The tests are about tracking
 * time: the page that creates a project is TS-011a's and has its own tests,
 * and a person may create five organisations, fewer than these tests need.
 */

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** Runs SQL against the local database; a moment's lock held by another test is waited out. */
function execute(sql: string) {
	for (let attempt = 1; ; attempt++) {
		try {
			execFileSync(
				"pnpm",
				["exec", "wrangler", "d1", "execute", "DB", "--local", "--command", sql],
				{
					stdio: "pipe",
				},
			);
			return;
		} catch (error) {
			if (attempt === 5) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
		}
	}
}

/** Gives the organisation with this slug an active project named `name`, and returns its id. */
export function seedProject(slug: string, name: string): string {
	const id = randomUUID();
	execute(
		"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) " +
			`select ${quote(id)}, id, ${quote(name)}, ${quote(name.toLowerCase())}, 0, 0 from organisations where slug = ${quote(slug)}`,
	);
	return id;
}

/**
 * A new organisation that the person with this address owns, with one active
 * project, Site. Returns its slug.
 */
export function seedOrganisation(ownerEmail: string): string {
	const organisation = randomUUID();
	const slug = `timesheet-${organisation.slice(0, 8)}`;
	execute(
		[
			`insert into organisations (id, name, slug, created_at, updated_at) values (${quote(organisation)}, 'Timesheet ${slug.slice(-8)}', ${quote(slug)}, 0, 0)`,
			`insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) select ${quote(randomUUID())}, ${quote(organisation)}, id, 'owner', 0, 0 from users where email = ${quote(ownerEmail)}`,
			`insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (${quote(randomUUID())}, ${quote(organisation)}, 'Site', 'site', 0, 0)`,
		].join("; "),
	);
	return slug;
}
