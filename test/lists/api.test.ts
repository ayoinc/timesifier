import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { organisationScope } from "~/db";
import { makeToken } from "~/integrations/api-tokens.server";
import { API_SCOPES } from "~/integrations/scopes";
import { captureEmail, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { type Crowd, everyone, PEOPLE, seedCrowd, seedWork } from "./crowd";

// The API of an organisation of 150 people (TS-112). Before TS-112 the first
// page of `/time_entries` named its projects in a parameter an entry, 101 and
// the organisation over D1's 100, whatever the organisation's size; `/users`
// and `/leave` named their people the same way, and `/users` had no pages
// (`research/corporate/scale-test.md`, D3).

let crowd: Crowd;
let token: string;

beforeEach(async () => {
	await freshDatabase();
	crowd = await seedCrowd(captureEmail());
	await seedWork(crowd);
	token = await makeToken(
		organisationScope(env.DB, crowd.acme.id),
		crowd.owner.user.id,
		"Test",
		API_SCOPES,
	);
}, 60_000);

async function api<T>(path: string): Promise<T> {
	const response = await exports.default.fetch(
		new Request(`${ORIGIN}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } }),
	);
	expect(response.status, path).toBe(200);
	return (await response.json()) as T;
}

type Page<R> = { data: R[]; next_cursor: string | null };

/** Every row of a list, page after page, and how many pages it took. */
async function everyPage<R>(path: string): Promise<{ rows: R[]; pages: number }> {
	const rows: R[] = [];
	let pages = 0;
	let cursor: string | null = null;
	do {
		const joiner = path.includes("?") ? "&" : "?";
		const next: Page<R> = await api<Page<R>>(
			cursor === null ? path : `${path}${joiner}cursor=${encodeURIComponent(cursor)}`,
		);
		rows.push(...next.data);
		pages += 1;
		cursor = next.next_cursor;
	} while (cursor !== null && pages < 20);
	return { rows, pages };
}

describe(`the API of an organisation of ${PEOPLE} people`, () => {
	it("answers /time_entries' first page of 100 entries over 100 projects, and every entry after it", async () => {
		// Each of the 147 has 5 entries on a project of their own, in one week, and the
		// three who sign in one each on the Monday.
		const first = await api<Page<{ project: { name: string | null } }>>(
			"/time_entries?from=2026-01-05&to=2026-01-11",
		);
		expect(first.data).toHaveLength(100);
		expect(first.data.every((entry) => entry.project.name?.startsWith("Project "))).toBe(true);
		expect(first.next_cursor).not.toBeNull();
		// The Monday: 150 entries over the 150 projects.
		const mondays = await everyPage<{ project: { name: string | null } }>(
			"/time_entries?from=2026-01-05&to=2026-01-05&per_page=100",
		);
		expect(mondays.rows).toHaveLength(PEOPLE);
		expect(new Set(mondays.rows.map((entry) => entry.project.name)).size).toBe(PEOPLE);
		const all = await everyPage("/time_entries?from=2026-01-05&to=2026-01-11");
		expect(all.rows).toHaveLength(147 * 5 + 3);
	});

	it("pages /users: every one of the 150, each once", async () => {
		const first = await api<Page<{ id: string; email: string }>>("/users");
		expect(first.data).toHaveLength(100);
		const { rows, pages } = await everyPage<{ id: string; name: string; email: string }>(
			"/users?per_page=60",
		);
		expect(pages).toBe(3);
		expect(rows.map((row) => row.id).sort()).toEqual(everyone(crowd).sort());
		expect(rows.find((row) => row.email === "person147@example.com")?.name).toBe("Person 147");
	});

	it("answers /leave naming 147 people, page after page", async () => {
		const annual = (
			await env.DB.prepare("update leave_requests set status = 'approved' returning user_id").all()
		).results;
		expect(annual).toHaveLength(147);
		const { rows, pages } = await everyPage<{ user: { name: string | null } }>("/leave");
		expect(pages).toBe(2);
		expect(rows).toHaveLength(147);
		expect(rows.every((row) => row.user.name?.startsWith("Person "))).toBe(true);
	});
});
