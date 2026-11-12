// Checks the settings of one deployment and writes them into the Wrangler
// configuration. The pipeline runs it before it builds, so nothing is built,
// migrated or deployed while a setting is missing or malformed.
//
//   node scripts/deploy-config.ts            check only: exit 1 names what is wrong
//   node scripts/deploy-config.ts --write    check, then rewrite wrangler.jsonc and
//                                            write wrangler.preview-migrations.jsonc
//
// An optional argument names the directory that holds wrangler.jsonc. In a
// GitHub Actions step, `--write` also gives the step two outputs: `origin`,
// where production is served, and `host_suffix`, what follows the name of a
// preview, or the first part of a version's id, in its workers.dev host.
//
// The committed wrangler.jsonc belongs to no deployment. Wrangler cannot read a
// value of its configuration from the environment, and it reads the file itself
// for `d1 migrations apply`, so the file is rewritten in the pipeline's checkout.
// `--write` on a developer's machine changes a tracked file: do not commit it
// (scripts/deploy-config.test.ts fails if it is).
// docs/security.md, "Secrets", lists every setting and where it is set.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as z from "zod";

const repository = fileURLToPath(new URL("..", import.meta.url));

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = `(?:${LABEL}\\.)+${LABEL}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The id the committed configuration holds, which is no database's. */
const NO_DATABASE = "00000000-0000-0000-0000-000000000000";
/** https://developers.cloudflare.com/turnstile/troubleshooting/testing/ */
const TURNSTILE_TEST_KEY = /^[123]x0+[A-Z]{2}$/;

const databaseId = (value: string) => UUID.test(value) && value !== NO_DATABASE;

/** Each GitHub variable: what it must be, in words, and the test of that. */
const VARIABLES = {
	APP_HOST: {
		is: "the host production is served on, in lower case, such as app.example.org",
		valid: (value: string) => new RegExp(`^${HOST}$`).test(value),
	},
	WORKERS_DEV_SUBDOMAIN: {
		is: "the account's workers.dev subdomain: the <name> in <name>.workers.dev",
		valid: (value: string) => new RegExp(`^${LABEL}$`).test(value),
	},
	D1_DATABASE_ID: {
		is: "the id of production's D1 database, as `wrangler d1 list` prints it",
		valid: databaseId,
	},
	D1_PREVIEW_DATABASE_ID: {
		is: "the id of the D1 database the previews share, as `wrangler d1 list` prints it",
		valid: databaseId,
	},
	TURNSTILE_SITE_KEY: {
		is: "the site key of production's own Turnstile widget, not a published test key",
		valid: (value: string) => /^[\w-]+$/.test(value) && !TURNSTILE_TEST_KEY.test(value),
	},
	EMAIL_FROM: {
		is: "the one address mail is sent from, such as no-reply@mail.example.org",
		valid: (value: string) => new RegExp(`^[^\\s@<>",;:]+@${HOST}$`).test(value),
	},
};
type Variable = keyof typeof VARIABLES;
type Values = Record<Variable, string>;

/**
 * The GitHub secrets the steps after this one need. This script is never given
 * their values: the workflow tells it only whether each is set.
 */
const SECRETS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

/** The values, or one line for each setting that is missing or is not what it must be. */
function readSettings(env: NodeJS.ProcessEnv): { values: Values } | { problems: string[] } {
	const values: Partial<Values> = {};
	const problems: string[] = [];
	for (const [name, { is, valid }] of Object.entries(VARIABLES)) {
		const value = env[name] ?? "";
		if (value === "") problems.push(`${name}: the variable is not set. It is ${is}.`);
		else if (!valid(value)) problems.push(`${name}: the variable is not valid. It is ${is}.`);
		else values[name as Variable] = value;
	}
	for (const name of SECRETS) {
		if (env[`${name}_IS_SET`] !== "true") problems.push(`${name}: the secret is not set.`);
	}
	// Previews run code nobody has reviewed. They never share production's data.
	if (values.D1_DATABASE_ID && values.D1_DATABASE_ID === values.D1_PREVIEW_DATABASE_ID) {
		problems.push("D1_PREVIEW_DATABASE_ID: it is production's database. Previews have their own.");
	}
	return problems.length > 0 ? { problems } : { values: values as Values };
}

const Database = z.looseObject({
	binding: z.string(),
	database_name: z.string(),
	database_id: z.string(),
	migrations_dir: z.string().optional(),
});
/** The parts of wrangler.jsonc this script reads or writes. Everything else passes through. */
const Config = z.looseObject({
	name: z.string(),
	vars: z.record(z.string(), z.string()),
	d1_databases: z.array(Database),
	send_email: z.array(z.looseObject({ name: z.string() })),
	// The Cron Triggers of workers/scheduled.ts. Production only:
	// previews never run cron triggers, and `previews` holds none.
	triggers: z.looseObject({ crons: z.array(z.string()).min(1) }),
	previews: z.looseObject({
		vars: z.record(z.string(), z.string()),
		d1_databases: z.array(Database),
	}),
});

function readConfig(path: string) {
	const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
	if (error) throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
	return Config.parse(config);
}

/** The one entry called `name`. A configuration without it is not one this script knows. */
function named<Entry>(entries: Entry[], name: string, nameOf: (entry: Entry) => string): Entry {
	const entry = entries.find((entry) => nameOf(entry) === name);
	if (!entry) throw new Error(`wrangler.jsonc has no binding named ${name}`);
	return entry;
}

/**
 * The configuration of one deployment: the committed one with this
 * deployment's values written in, and the one that migrates the database the
 * previews share. `wrangler d1 migrations apply` reads top-level databases
 * only, so the previews' database needs a file in which it is one:
 * https://developers.cloudflare.com/workers/previews/resources/#d1-migrations
 */
function deploymentConfig(base: z.infer<typeof Config>, values: Values) {
	const config = structuredClone(base);
	const database = named(config.d1_databases, "DB", ({ binding }) => binding);
	const previewDatabase = named(config.previews.d1_databases, "DB", ({ binding }) => binding);
	const email = named(config.send_email, "EMAIL", ({ name }) => name);

	// Production answers on its host alone; `www.` is redirected to it
	// (workers/canonical-host.ts).
	config.routes = [values.APP_HOST, `www.${values.APP_HOST}`].map((pattern) => ({
		pattern,
		custom_domain: true,
	}));
	// The whole list is replaced: no value of a developer's machine is deployed.
	config.vars = {
		ENVIRONMENT: "production",
		APP_HOST: values.APP_HOST,
		TURNSTILE_SITE_KEY: values.TURNSTILE_SITE_KEY,
		EMAIL_FROM: values.EMAIL_FROM,
	};
	database.database_id = values.D1_DATABASE_ID;
	email.allowed_sender_addresses = [values.EMAIL_FROM];
	// Production must name its platform owners (TS-099); a preview, which shares
	// the committed list, may not, and its console is then closed.
	config.secrets = { required: ["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY", "PLATFORM_OWNERS"] };

	// A preview is `<its name>-<worker>.<subdomain>.workers.dev`.
	const hostSuffix = `-${config.name}.${values.WORKERS_DEV_SUBDOMAIN}.workers.dev`;
	config.previews.vars.PREVIEW_HOST_SUFFIX = hostSuffix;
	previewDatabase.database_id = values.D1_PREVIEW_DATABASE_ID;

	const previewMigrations = {
		d1_databases: [
			{
				binding: "PREVIEW_DB",
				database_name: previewDatabase.database_name,
				database_id: previewDatabase.database_id,
				migrations_dir: database.migrations_dir,
			},
		],
	};
	return { config, previewMigrations, hostSuffix };
}

const WRITTEN_BY =
	"// Written by scripts/deploy-config.ts for one deployment. Never commit this file.\n";

const args = process.argv.slice(2);
const directory = resolve(args.find((arg) => !arg.startsWith("--")) ?? repository);
const settings = readSettings(process.env);

if ("problems" in settings) {
	console.error(
		"FAIL: this deployment's settings are incomplete. Each is a variable or a secret of the\n" +
			'repository in GitHub (Settings, Secrets and variables, Actions); docs/security.md, "Secrets".',
	);
	for (const problem of settings.problems) console.error(`  ${problem}`);
	process.exit(1);
}

const names = [...Object.keys(VARIABLES), ...SECRETS].join(", ");
console.log(`ok: ${names} are set`);

if (args.includes("--write")) {
	const base = readConfig(join(directory, "wrangler.jsonc"));
	const { config, previewMigrations, hostSuffix } = deploymentConfig(base, settings.values);
	const files = {
		"wrangler.jsonc": config,
		"wrangler.preview-migrations.jsonc": previewMigrations,
	};
	for (const [file, value] of Object.entries(files)) {
		writeFileSync(join(directory, file), `${WRITTEN_BY}${JSON.stringify(value, null, "\t")}\n`);
	}
	console.log("ok: wrote wrangler.jsonc and wrangler.preview-migrations.jsonc for this deployment");
	if (process.env.GITHUB_OUTPUT) {
		const outputs = `origin=https://${settings.values.APP_HOST}\nhost_suffix=${hostSuffix}\n`;
		appendFileSync(process.env.GITHUB_OUTPUT, outputs);
	}
}
