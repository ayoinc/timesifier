import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("..", import.meta.url));

/** The settings of a deployment that is nobody's. */
const SETTINGS = {
	APP_HOST: "time.example.org",
	WORKERS_DEV_SUBDOMAIN: "acme",
	D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
	D1_PREVIEW_DATABASE_ID: "22222222-2222-4222-8222-222222222222",
	TURNSTILE_SITE_KEY: "0x4AAAAAAA-not-a-real-site-key",
	EMAIL_FROM: "hello@post.example.net",
	CLOUDFLARE_API_TOKEN_IS_SET: "true",
	CLOUDFLARE_ACCOUNT_ID_IS_SET: "true",
};

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

/** A directory with a copy of the committed wrangler.jsonc, removed when the test ends. */
function checkout(): string {
	const directory = mkdtempSync(join(tmpdir(), "deploy-config-"));
	directories.push(directory);
	copyFileSync(join(repository, "wrangler.jsonc"), join(directory, "wrangler.jsonc"));
	return directory;
}

/** Runs the script with these settings and nothing else of this machine's environment. */
function deployConfig(settings: Record<string, string>, ...args: string[]) {
	const result = spawnSync(process.execPath, ["scripts/deploy-config.ts", ...args], {
		cwd: repository,
		encoding: "utf8",
		env: { PATH: process.env.PATH, ...settings },
	});
	return { status: result.status, out: result.stdout, problems: result.stderr.trim().split("\n") };
}

function readJsonc(path: string) {
	const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
	if (error) throw new Error(`${path} is not JSONC`);
	return config;
}

describe("scripts/deploy-config.ts, the check before every deploy", () => {
	it("passes with every setting, and without --write changes nothing", () => {
		const directory = checkout();
		const before = readFileSync(join(directory, "wrangler.jsonc"), "utf8");

		const { status, out } = deployConfig(SETTINGS, directory);

		expect(out).toContain("APP_HOST, WORKERS_DEV_SUBDOMAIN, D1_DATABASE_ID");
		expect(status).toBe(0);
		expect(readFileSync(join(directory, "wrangler.jsonc"), "utf8")).toBe(before);
		expect(existsSync(join(directory, "wrangler.preview-migrations.jsonc"))).toBe(false);
	});

	it("with no setting at all fails, names every one, and writes nothing", () => {
		const directory = checkout();
		const before = readFileSync(join(directory, "wrangler.jsonc"), "utf8");

		const { status, problems } = deployConfig({}, "--write", directory);

		expect(status).toBe(1);
		expect(problems.slice(2).map((line) => line.trim().split(":")[0])).toEqual([
			"APP_HOST",
			"WORKERS_DEV_SUBDOMAIN",
			"D1_DATABASE_ID",
			"D1_PREVIEW_DATABASE_ID",
			"TURNSTILE_SITE_KEY",
			"EMAIL_FROM",
			"CLOUDFLARE_API_TOKEN",
			"CLOUDFLARE_ACCOUNT_ID",
		]);
		expect(readFileSync(join(directory, "wrangler.jsonc"), "utf8")).toBe(before);
		expect(existsSync(join(directory, "wrangler.preview-migrations.jsonc"))).toBe(false);
	});

	it.each(Object.keys(SETTINGS))("without %s alone fails and names it", (name) => {
		const { status, problems } = deployConfig({ ...SETTINGS, [name]: "" }, "--write", checkout());

		expect(status).toBe(1);
		expect(problems).toHaveLength(3);
		expect(problems[2]).toMatch(
			new RegExp(`^  ${name.replace(/_IS_SET$/, "")}: the (variable|secret) is not set\\.`),
		);
	});

	it.each([
		["APP_HOST", "https://time.example.org", "a URL is not a host"],
		["APP_HOST", "time.example.org/", "nor is a path"],
		["APP_HOST", "*.example.org", "nor a pattern"],
		["APP_HOST", "Time.Example.org", "the Worker compares hosts in lower case"],
		["APP_HOST", "localhost", "one label is not a domain"],
		["WORKERS_DEV_SUBDOMAIN", "acme.workers.dev", "the subdomain alone"],
		["WORKERS_DEV_SUBDOMAIN", "*", "not a pattern"],
		["D1_DATABASE_ID", "timesifier", "a name is not an id"],
		["D1_DATABASE_ID", "00000000-0000-0000-0000-000000000000", "the id that is no database's"],
		["D1_PREVIEW_DATABASE_ID", "", "missing"],
		["TURNSTILE_SITE_KEY", "1x00000000000000000000AA", "a test key passes every robot"],
		["TURNSTILE_SITE_KEY", "2x00000000000000000000AB", "a test key"],
		["TURNSTILE_SITE_KEY", "a key\nwith a line", "one token"],
		["EMAIL_FROM", "Timesifier <no-reply@mail.example.org>", "the address alone"],
		["EMAIL_FROM", "no-reply@mail.example.org,eve@attacker.example", "one address"],
		["EMAIL_FROM", "no-reply", "an address"],
	])("refuses %s = %j (%s)", (name, value) => {
		const directory = checkout();

		const { status, problems } = deployConfig({ ...SETTINGS, [name]: value }, "--write", directory);

		expect(status).toBe(1);
		expect(problems[2]).toMatch(new RegExp(`^  ${name}: the variable is not (valid|set)\\.`));
		expect(existsSync(join(directory, "wrangler.preview-migrations.jsonc"))).toBe(false);
	});

	it("refuses to give the previews production's database", () => {
		const settings = { ...SETTINGS, D1_PREVIEW_DATABASE_ID: SETTINGS.D1_DATABASE_ID };

		const { status, problems } = deployConfig(settings, "--write", checkout());

		expect(status).toBe(1);
		expect(problems[2]).toContain("D1_PREVIEW_DATABASE_ID: it is production's database.");
	});

	it("never prints a value it was given", () => {
		const { out, problems } = deployConfig({ ...SETTINGS, EMAIL_FROM: "not an address" });

		for (const value of [...Object.values(SETTINGS), "not an address"]) {
			if (value === "true") continue;
			expect(`${out}\n${problems.join("\n")}`).not.toContain(value);
		}
	});
});

describe("scripts/deploy-config.ts --write", () => {
	it("writes the deployment's values into the configuration and leaves the rest as it was", () => {
		const directory = checkout();
		const committed = readJsonc(join(directory, "wrangler.jsonc"));

		const { status } = deployConfig(SETTINGS, "--write", directory);
		const written = readJsonc(join(directory, "wrangler.jsonc"));

		expect(status).toBe(0);
		expect(written).toEqual({
			...committed,
			secrets: { required: ["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY", "PLATFORM_OWNERS"] },
			routes: [
				{ pattern: "time.example.org", custom_domain: true },
				{ pattern: "www.time.example.org", custom_domain: true },
			],
			// Nothing of a developer's machine is deployed, and production is told
			// nothing about previews.
			vars: {
				ENVIRONMENT: "production",
				APP_HOST: "time.example.org",
				TURNSTILE_SITE_KEY: "0x4AAAAAAA-not-a-real-site-key",
				EMAIL_FROM: "hello@post.example.net",
			},
			d1_databases: [
				{
					binding: "DB",
					database_name: "timesifier",
					database_id: "11111111-1111-4111-8111-111111111111",
					migrations_dir: "migrations",
				},
			],
			send_email: [{ name: "EMAIL", allowed_sender_addresses: ["hello@post.example.net"] }],
			previews: {
				vars: {
					ENVIRONMENT: "preview",
					TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
					TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
					PREVIEW_HOST_SUFFIX: "-timesifier.acme.workers.dev",
				},
				d1_databases: [
					{
						binding: "DB",
						database_name: "timesifier-preview",
						database_id: "22222222-2222-4222-8222-222222222222",
					},
				],
				r2_buckets: committed.previews.r2_buckets,
			},
		});
		// Still what stops a deploy whose Worker has no secrets; production also needs its platform owners (TS-099).
		expect(written.secrets).toEqual({
			required: ["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY", "PLATFORM_OWNERS"],
		});
		expect(written.workers_dev).toBe(false);
	});

	it("writes the file that migrates the previews' database, and it names that database alone", () => {
		const directory = checkout();

		deployConfig(SETTINGS, "--write", directory);

		expect(readJsonc(join(directory, "wrangler.preview-migrations.jsonc"))).toEqual({
			d1_databases: [
				{
					binding: "PREVIEW_DB",
					database_name: "timesifier-preview",
					database_id: "22222222-2222-4222-8222-222222222222",
					migrations_dir: "migrations",
				},
			],
		});
	});

	it("tells the steps after it where production is served and what a workers.dev host ends with", () => {
		const directory = checkout();
		const output = join(directory, "github-output");

		deployConfig({ ...SETTINGS, GITHUB_OUTPUT: output }, "--write", directory);

		expect(readFileSync(output, "utf8")).toBe(
			"origin=https://time.example.org\nhost_suffix=-timesifier.acme.workers.dev\n",
		);
	});
});

describe("the committed wrangler.jsonc belongs to no deployment", () => {
	const config = readJsonc(join(repository, "wrangler.jsonc"));

	it("names no host, no key and no address of one", () => {
		expect(config.routes).toBeUndefined();
		expect(config.vars).toEqual({
			ENVIRONMENT: "development",
			APP_HOST: "",
			PREVIEW_HOST_SUFFIX: "",
			TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
			EMAIL_FROM: "no-reply@localhost",
		});
		expect(config.previews.vars.PREVIEW_HOST_SUFFIX).toBeUndefined();
		expect(config.send_email).toEqual([{ name: "EMAIL" }]);
	});

	it("names no database: an id is there, so Wrangler never looks one up by name, and it is no database's", () => {
		const databases = [...config.d1_databases, ...config.previews.d1_databases];

		expect(databases.map(({ database_id }) => database_id)).toEqual([
			"00000000-0000-0000-0000-000000000000",
			"00000000-0000-0000-0000-000000000000",
		]);
	});

	it("says when the Worker's runtime is from, and which secrets a deploy must find", () => {
		expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(config.secrets).toEqual({ required: ["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY"] });
	});

	it("runs the scheduled work in production, and never in a preview", () => {
		expect(config.triggers).toEqual({ crons: ["* * * * *", "0 * * * *", "17 3 * * *"] });
		expect(config.previews.triggers).toBeUndefined();
	});
});
