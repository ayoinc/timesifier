import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";

/**
 * Empties the local D1 and rebuilds it from the committed migrations, so each
 * test starts from the schema alone. `TEST_MIGRATIONS` is set in vitest.config.ts.
 */
export async function freshDatabase(): Promise<D1Database> {
	await reset();
	const { TEST_MIGRATIONS } = env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
	await applyD1Migrations(env.DB, TEST_MIGRATIONS);
	return env.DB;
}
