import { env } from "cloudflare:workers";

import type { Route } from "./+types/health";

// The application's own check, for the monitors outside it (TS-107a, decision
// 61): can the Worker reach its database and its files? One cheap question to
// each, `SELECT 1` and the head of a key that need not exist, so the check reads
// no row, writes nothing and touches nobody's data. The answer names each part
// and nothing else: no version, no message, no address, nothing a row holds.

/** Where the monitors ask. Outside `PUBLIC_PAGES`: it is not a page. */
export const HEALTH_PATH = "/health";

/** How long one location reuses an answer, so a flood of checks costs no D1 or R2 operation. */
export const HEALTH_CACHE_SECONDS = 30;

/** How long a part may take to answer before it counts as failing. */
const PART_TIMEOUT_MS = 5_000;

/** The R2 key whose head is asked for. Nothing is stored there: `null` is a good answer. */
const FILES_PROBE_KEY = "health";

type PartState = "ok" | "failing";

export type HealthBody = {
	status: PartState;
	database: PartState;
	files: PartState;
};

/** The cache, in this location, the answer is kept in, and the key it is kept under. */
export const HEALTH_CACHE = "health";
export function healthCacheKey(origin: string): Request {
	return new Request(`${origin}${HEALTH_PATH}`);
}

async function check(
	part: keyof Omit<HealthBody, "status">,
	ask: () => Promise<unknown>,
): Promise<PartState> {
	let timer: number | undefined;
	// The project's library target predates `Promise.withResolvers`.
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Timeout")), PART_TIMEOUT_MS);
	});
	try {
		await Promise.race([ask(), timeout]);
		return "ok";
	} catch (error) {
		// The error's name alone, as everywhere else (docs/security.md, "Never logged").
		console.error(`health: ${part} failing: ${error instanceof Error ? error.name : "error"}`);
		return "failing";
	} finally {
		clearTimeout(timer);
	}
}

function answer(response: Response): Response {
	const headers = new Headers({
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	return new Response(response.body, { status: response.status, headers });
}

export async function loader({ request }: Route.LoaderArgs) {
	const cache = await caches.open(HEALTH_CACHE);
	const key = healthCacheKey(new URL(request.url).origin);
	const cached = await cache.match(key);
	if (cached) return answer(cached);

	const [database, files] = await Promise.all([
		check("database", () => env.DB.prepare("SELECT 1").first()),
		check("files", () => env.BRAND.head(FILES_PROBE_KEY)),
	]);
	const body: HealthBody = {
		status: database === "ok" && files === "ok" ? "ok" : "failing",
		database,
		files,
	};
	const fresh = new Response(JSON.stringify(body), {
		status: body.status === "ok" ? 200 : 503,
		headers: { "Cache-Control": `max-age=${HEALTH_CACHE_SECONDS}` },
	});
	await cache.put(key, fresh.clone());
	return answer(fresh);
}
