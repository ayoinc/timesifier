import type { TestProject } from "vitest/node";

/**
 * Before any test file starts, Vite transforms every module the Worker can
 * load: workers/app.ts and all it imports, the whole application through the
 * server build included, about 2,500 modules (vitest.workers.config.ts,
 * `globalSetup`).
 *
 * Without this, the first test files of a run transformed them all as their
 * first requests loaded the application, one module at a time and several
 * files at once. On a CI runner that took a first request 8 to 9 seconds, in
 * whatever hook or test made it; a `beforeEach` that signs a person in has 10
 * (run 45396411570, test/organisations/domains.test.ts). Transformed here,
 * once and side by side, it takes a few seconds, and each file's first request
 * only evaluates what is already transformed.
 *
 * The runtime's own modules (`cloudflare:`, `node:`) are not Vite's to
 * transform. A virtual module is imported as `/@id/__x00__<id>` and
 * transformed by its id.
 */
export default async function warmUp(project: TestProject): Promise<void> {
	const ssr = project.vite.environments.ssr;
	const seen = new Set<string>();
	async function transform(url: string): Promise<void> {
		if (seen.has(url)) return;
		seen.add(url);
		const result = await ssr.transformRequest(url);
		const imported = [...(result?.deps ?? []), ...(result?.dynamicDeps ?? [])];
		await Promise.all(
			imported
				.map(urlToTransform)
				.filter((next) => next !== null)
				.map(transform),
		);
	}
	await transform("/workers/app.ts");
}

const VIRTUAL = "/@id/__x00__";

/** The URL to transform `imported` by, or null for one of the runtime's own modules. */
function urlToTransform(imported: string): string | null {
	if (imported.startsWith(VIRTUAL)) return imported.slice(VIRTUAL.length);
	return imported.startsWith("/") ? imported : null;
}
