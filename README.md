# Timesifier

Timesifier helps individuals and teams understand and improve how they use their time: track it, plan focus around meetings, and see where it went. It runs entirely on Cloudflare at `timesifier.com`.

## Status

The scaffold is live at <https://timesifier.com> and the foundation is being built card by card. `BOARD.md` shows what is done.

## Where things are

| File                      | What it holds                                                      |
| ------------------------- | ------------------------------------------------------------------ |
| `BOARD.md`                | The Kanban board: every card with its acceptance criteria          |
| `docs/product.md`         | What Timesifier is, who it is for, what release 1 includes         |
| `docs/architecture.md`    | The Cloudflare services, environments, delivery and the domain     |
| `docs/design-system.md`   | Material 3 tokens, the design principles and the rules that follow |
| `docs/security.md`        | The security baseline and where secrets live                       |
| `docs/ways-of-working.md` | How a card moves, Definition of Ready and Done                     |
| `docs/decisions.md`       | Settled choices and their evidence                                 |
| `AGENTS.md`               | Instructions for AI coding assistants working in this repository   |

## Quick start

Needs Node 26 and pnpm 12.

```sh
pnpm install
pnpm dev          # the local address is printed; the app runs in the Workers runtime
```

Before opening a pull request:

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e
```

`pnpm format` fixes formatting and import order. Local secrets go in `.dev.vars`; see `.dev.vars.example` and `docs/security.md`.

Browser tests:

```sh
pnpm exec playwright install chromium webkit   # once, and again after Playwright is upgraded
pnpm test:e2e                                  # about 20 seconds
```

`pnpm test:e2e` builds for production with `DESIGN_ROUTE=1`, serves that build on port 5385, and runs the tests in `e2e/` against it with Playwright: each component by keyboard, the application shell at 390px and 1280px (navigation, view transitions, focus, the colour scheme), accessibility scans, reduced motion, and the overlays in WebKit as iOS runs them. Every test fails if the page breaks the Content Security Policy or logs an error. When the tests end the build is deleted, because it contains the component gallery; run `pnpm build` again before anything else uses `build/`.

The component gallery is at `/design` under `pnpm dev`: every component in every state, in both colour schemes. A normal build leaves the route out, so production answers 404. `docs/design-system.md` describes the components and how to add one.

Design tokens:

```sh
pnpm tokens        # regenerate app/styles/tokens.css after changing scripts/tokens.ts
pnpm check:tokens  # fail if a file under app/ holds a hex colour or an arbitrary Tailwind value
```

## Signing in locally

Sign-in needs three values in `.dev.vars` and the local database:

```sh
cp .dev.vars.example .dev.vars && chmod 600 .dev.vars   # then fill in the three values as the file explains
pnpm db:migrate:local
```

- `BETTER_AUTH_SECRET`: any random value, for example from `openssl rand -base64 32`.
- `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY`: Cloudflare's published test keys, which pass every check. They are written in `.dev.vars.example`.

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
