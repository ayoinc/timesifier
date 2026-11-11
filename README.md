# Timesifier

Timesifier helps individuals and teams understand and improve how they use their time: track it, plan focus around meetings, and see where it went. It runs entirely on Cloudflare at `timesifier.com`.

## Status

The application is live at <https://timesifier.com>. `BOARD.md` shows what is done, what is being built and what comes next.

## Where things are

| File                      | What it holds                                                      |
| ------------------------- | ------------------------------------------------------------------ |
| `BOARD.md`                | The Kanban board: every card with its acceptance criteria          |
| `docs/board-done.md`      | The cards that are Done, with their evidence                       |
| `docs/product.md`         | What Timesifier is, who it is for, what release 1 includes         |
| `docs/architecture.md`    | The Cloudflare services, environments, delivery and the domain     |
| `docs/design-system.md`   | Material 3 tokens, the design principles and the rules that follow |
| `docs/security.md`        | The security baseline and where secrets live                       |
| `docs/ways-of-working.md` | How a card moves, Definition of Ready and Done                     |
| `docs/decisions.md`       | Settled choices and their evidence                                 |
| `AGENTS.md`               | Instructions for AI coding assistants working in this repository   |

## Quick start

Needs Node 26 and pnpm 12; the exact versions the pipeline uses are in `.node-version` and in `packageManager` in `package.json`.

```sh
pnpm install
cp .dev.vars.example .dev.vars && chmod 600 .dev.vars   # then fill in the two values as the file explains
pnpm db:migrate:local
pnpm dev          # the local address is printed; the app runs in the Workers runtime
```

Open the address with `localhost`, not `127.0.0.1`: sign-in answers only on `localhost`. "Signing in locally" below says what the values are.

Before opening a pull request, run the checks in the Definition of Done in `docs/ways-of-working.md`. The local ones are:

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e
```

`pnpm format` fixes formatting and import order. Local secrets go in `.dev.vars`; see `.dev.vars.example` and `docs/security.md`.

Browser tests:

```sh
pnpm exec playwright install chromium webkit   # once, and again after Playwright is upgraded
pnpm test:e2e                                  # about a minute
```

`pnpm test:e2e` builds for production with `DESIGN_ROUTE=1`, serves that build on port 5385, and runs the tests in `e2e/` against it with Playwright: each component by keyboard, the application shell at 390px and 1280px (navigation, view transitions, focus, the colour scheme), signing up and signing in with an email code, what the pages say when the answer is no, accessibility scans and reduced motion. Everything runs in Chromium. The component tests run again in WebKit, Safari's engine, which has styled a field differently from Chromium; the tests that need a session cannot, because WebKit does not keep a `Secure` cookie on `http://localhost`. The overlays run in WebKit as iOS runs them. Every test fails if the page breaks the Content Security Policy or logs an error. When the tests end the build is deleted, because it contains the component gallery; run `pnpm build` again before anything else uses `build/`.

The run needs nothing set up: `playwright.config.ts` gives the server a throwaway signing secret and Cloudflare's published Turnstile test keys, and applies the migrations to the local database. Two things to know. It refuses to start while its port is taken, so two checkouts running at once need different ports: `E2E_PORT=5386 pnpm test:e2e`. And it signs its test people up in the same local database `pnpm dev` uses (`.wrangler/state`), reading their sign-in codes from the files Wrangler's local email binding writes under `.wrangler/tmp/email/`; nothing is sent. To clear them out, delete `.wrangler/state/v3/d1` and run `pnpm db:migrate:local`.

The component gallery is at `/design` under `pnpm dev`: every component in every state, in both colour schemes. A normal build leaves the route out, so production answers 404. `docs/design-system.md` describes the components and how to add one.

Design tokens:

```sh
pnpm tokens        # regenerate app/styles/tokens.css after changing scripts/tokens.ts
pnpm check:tokens  # fail if a file under app/ holds a hex colour or an arbitrary Tailwind value
```

## Signing in locally

Sign-in needs two secrets in `.dev.vars` and the local database. The quick start above makes both.

- `BETTER_AUTH_SECRET`: any random value, for example from `openssl rand -base64 32`.
- `TURNSTILE_SECRET_KEY`: Cloudflare's published test secret, which passes every check. It is written in `.dev.vars.example`.

Everything else the Worker reads is a variable with a local value in `wrangler.jsonc`: it trusts `localhost` and nothing else, shows Turnstile's test widget, and names databases that do not exist remotely. The repository names no production or preview resource, so no command in this file can reach one from a clone.

Local email is not sent. When the application emails a sign-in code, Wrangler prints the sender, recipient and subject in the terminal running `pnpm dev` and writes the message to a file under `.wrangler/tmp/email/`; the code is in that file. Tests replace the sender and need neither `.dev.vars` nor a mailbox, but the Turnstile tests call Cloudflare's `siteverify` and so need the network.

The session cookie is `Secure` with the `__Host-` prefix. Chrome keeps it from `http://localhost`; Safari does not, so sign-in will not stick there.

Everything under `/api/auth/` is Better Auth; `app/auth/auth.server.ts` holds its configuration and `docs/security.md` ("Authentication") says what it does.

## Database

The schema is `app/db/schema.ts`. Changes reach a database only as the SQL migrations in `migrations/`.

```sh
pnpm db:migrate:local   # apply the committed migrations to the local D1 that `pnpm dev` uses
pnpm db:generate        # after changing the schema: write the next migration into migrations/
```

After `pnpm db:generate`, run `pnpm format` (it tidies the snapshot files drizzle-kit writes) and commit the generated files with the schema change; `pnpm test` fails when the schema and the migrations disagree. To start again locally, delete `.wrangler/state/v3/d1` and run `pnpm db:migrate:local`.

**Migrations are applied to the preview and production databases only by the pipeline, never from a laptop.** There is no script for it, and `wrangler d1 migrations apply --remote` is not run by hand.

## Delivery

Every pull request is checked and gets a preview URL as a comment. Merging to `main` deploys to production; nothing is deployed from a laptop. The steps, the pipeline's token and the rollback command are in `docs/architecture.md`.

## Deploying your own

The repository holds nothing of the deployment at `timesifier.com`: no domain, database id, key or address. A deployment is a Cloudflare account, a fork, and the settings below. `docs/security.md`, "Secrets", says what reads each one and what happens without it.

You need a Cloudflare account with your domain on it as a zone, Workers with a `workers.dev` subdomain, and Wrangler signed in (`pnpm exec wrangler login`). Then, in a clone of your fork:

1. **Two databases.** Each command prints the id you need in step 6.

   ```sh
   pnpm exec wrangler d1 create timesifier --jurisdiction eu
   pnpm exec wrangler d1 create timesifier-preview --jurisdiction eu
   ```

2. **A Turnstile widget** for your host, in the Cloudflare dashboard under Turnstile. It gives a site key, which is public, and a secret key.
3. **A sending domain** in Cloudflare Email Service, for example `mail.<your domain>`, and one address on it to send from.
4. **The Worker's secrets.** The first command offers to create the Worker `timesifier`; accept. Each asks for the value and stores it at Cloudflare.

   ```sh
   openssl rand -base64 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
   pnpm exec wrangler secret put TURNSTILE_SECRET_KEY                          # the widget's secret key
   openssl rand -base64 32 | pnpm exec wrangler preview base-config secret put BETTER_AUTH_SECRET
   ```

5. **A token for the pipeline**, in the dashboard under Manage Account, Account API tokens, with the three scopes listed in `docs/architecture.md`, "The pipeline's token", for your Worker and your zone.
6. **The repository's settings** in GitHub, under Settings, Secrets and variables, Actions.

   | Kind     | Name                     | Value                                                            |
   | -------- | ------------------------ | ---------------------------------------------------------------- |
   | Secret   | `CLOUDFLARE_API_TOKEN`   | The token from step 5                                            |
   | Secret   | `CLOUDFLARE_ACCOUNT_ID`  | Your account id                                                  |
   | Variable | `APP_HOST`               | The host to serve on, such as `app.example.org`; `www.` is added |
   | Variable | `WORKERS_DEV_SUBDOMAIN`  | The `<name>` in your account's `<name>.workers.dev`              |
   | Variable | `D1_DATABASE_ID`         | The id of `timesifier` from step 1                               |
   | Variable | `D1_PREVIEW_DATABASE_ID` | The id of `timesifier-preview` from step 1                       |
   | Variable | `TURNSTILE_SITE_KEY`     | The widget's site key from step 2                                |
   | Variable | `EMAIL_FROM`             | The address from step 3, alone: `no-reply@mail.example.org`      |

7. **Deploy.** Push to `main`, or open a pull request for a preview. The job checks the settings before it builds anything, and fails with the name of each one that is missing or malformed. Then it migrates the database, deploys, and runs the smoke test against your host.

To check the settings without deploying, run the same check with the values in the environment: `node scripts/deploy-config.ts` prints what is missing and changes nothing. With `--write` it rewrites `wrangler.jsonc` for one deployment, which is what the pipeline does in its own checkout; never commit that.
