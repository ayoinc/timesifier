# Architecture

Timesifier runs entirely on Cloudflare. One Worker serves the pages, runs the server code and talks to every other service through bindings.

Status: the scaffold is deployed at `https://timesifier.com` and the pipeline deploys every merge. The parts below arrive with the cards named beside them. Why each part was chosen is in `docs/decisions.md`.

## Shape

```mermaid
flowchart LR
  B[Browser] -->|HTTPS| W[Worker: React Router v8<br/>pages, loaders, actions]
  W --> A[Static assets]
  W --> D[(D1: system of record)]
  W --> AI[Workers AI<br/>via AI Gateway]
  W --> Q[Queues and Workflows<br/>background work]
  W --> E[Email sending]
  T[Turnstile] -.->|verifies sign-up| W
  GH[GitHub Actions] -->|wrangler deploy| W
```

## Parts

| Part            | Cloudflare product                               | Used for                                                | Arrives with    |
| --------------- | ------------------------------------------------ | ------------------------------------------------------- | --------------- |
| Application     | Workers, React Router v8, Cloudflare Vite plugin | Pages, loaders, actions                                 | TS-001          |
| Static files    | Workers Static Assets                            | Scripts, styles, images                                 | TS-001          |
| Database        | D1 with Drizzle and SQL migrations               | Users, organisations, time entries, everything durable  | TS-007          |
| Authentication  | Better Auth in the Worker, data in D1            | Passkeys, email sign-in, sessions, organisations, roles | TS-008          |
| Bot protection  | Turnstile                                        | Sign-up                                                 | TS-008          |
| Email           | Cloudflare email sending, from its own subdomain | Verification and summaries                              | TS-008          |
| AI              | Workers AI behind AI Gateway                     | Category suggestions                                    | TS-015          |
| Background work | Queues, Workflows, Cron Triggers                 | Weekly summaries, batches                               | TS-018          |
| Files           | R2                                               | Data exports                                            | TS-021          |
| Real-time       | Durable Objects                                  | Only when a feature needs live coordination             | Not planned yet |
| Observability   | Workers Logs and Traces                          | Structured logs, traces, alerts                         | TS-001, TS-022  |

## Environments

| Environment | Where                                                                     | Data                                  |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------- |
| Local       | `pnpm dev`, running in the Workers runtime                                | Local D1 file, secrets in `.dev.vars` |
| Preview     | `https://pr-<number>-timesifier.ayoinc.workers.dev`, one per pull request | Preview D1 database                   |
| Production  | `https://timesifier.com`                                                  | Production D1 database                |

## Data rules

- Every table that holds customer data has an `organisation_id`. Code reads and writes it only through the organisation-scoped data layer.
- Times are stored in UTC and shown in the person's time zone.
- Schema changes are SQL migrations in the repository, applied to remote databases by the pipeline only.
- The production database is created in the EU. The exact option is confirmed in TS-007.

## Delivery

One workflow, `.github/workflows/ci.yml`, does all of it.

1. A pull request runs install with a frozen lockfile, typecheck, lint, tests, build, a secret scan and a dependency audit.
2. When those pass, the pull request gets a preview (`wrangler preview --name pr-<number>`), the smoke test runs against it, and its URL is posted as a comment. Closing the pull request deletes the preview.
3. Merging to `main` runs the same checks, then `wrangler deploy`, then the smoke test against production.
4. The smoke test is `scripts/smoke.sh`: the home page must answer 200 and contain the product name, and `www` must redirect to the apex. A failure fails the workflow; it does not roll back by itself.

Production is deployed only by the pipeline. The one exception was the first deploy on 2026-11-11, made from the owner's machine, because a token limited to one Worker cannot create that Worker.

### The pipeline's token

An account-owned Cloudflare API token named `timesifier-ci-deploy`, held in the GitHub Actions secret `CLOUDFLARE_API_TOKEN` and passed only to the steps that call Wrangler. It expires on **2027-11-11**; replace it before then in the Cloudflare dashboard under Manage Account, Account API tokens.

| Scope                            | Permission     | Used for                              |
| -------------------------------- | -------------- | ------------------------------------- |
| Worker `timesifier` only         | Editor         | Deploys, previews, rollbacks          |
| Zone `timesifier.com` only       | Workers Routes | The two custom domains                |
| Every D1 database in the account | D1 write       | Applying migrations from the pipeline |

Cloudflare offers no per-database scope for D1, so the last row is wider than this project. Checked on 2026-11-11: the token is refused when it asks for another Worker's settings or for this zone's DNS records.

### Rollback

```sh
pnpm exec wrangler deployments list                      # find the version to return to
pnpm exec wrangler rollback <version-id> -m "<reason>"   # production serves it within seconds
```

A rollback changes the code only. It does not undo a database migration, a secret or a setting. Then revert the faulty commit on `main`, or the next merge deploys it again.

Rehearsed on 2026-11-11: at 02:36:49 UTC production was rolled back from version `05a58e49` to `d1625379` and answered 200; at 02:37:07 UTC it was returned to `05a58e49` with `wrangler versions deploy 05a58e49-27a2-49bf-a36e-4bd17fbeffae@100%` and answered 200.

## The domain

`timesifier.com` is a zone in the owner's Cloudflare account. Before 2026-11-11 it held 27 DNS records and served no website: the apex and `www` had no address records. TS-003 attached both names to the Worker as custom domains. `www` redirects to the apex with status 308.

The zone carries **live email configuration** and one other service that the application must leave alone:

| Name                                                                  | What is there                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `timesifier.com`                                                      | MX to Microsoft 365, SPF, a Microsoft verification record, DMARC `p=none` |
| `autodiscover`                                                        | Outlook autodiscover                                                      |
| `*._domainkey`, `send`, `send.updates`, `plunk`, `resend._domainkey*` | DKIM and bounce records for Amazon SES, Resend, Plunk and iCloud mail     |
| `trade`                                                               | Cloudflare email routing and sending records with DMARC `p=reject`        |
| Two `_…` CNAMEs                                                       | AWS certificate validation                                                |
| `paperclip`                                                           | Another Worker of the owner's, on its own custom domain                   |

The application adds only the Worker custom domains for the apex and `www`, and later one dedicated subdomain for its own outgoing email. TS-003 checked the zone after the first deploy: of its 29 records, the only two created or changed that day were the Worker records for the apex and `www`.

## Versions

Read from the lockfile on 2026-11-11. The lockfile is the source of truth; update this table when a major version changes.

| Tool                     | Version    |
| ------------------------ | ---------- |
| Node                     | 26         |
| pnpm                     | 12.18.0    |
| Wrangler                 | 4.159.0    |
| React Router             | 8.5.1      |
| React                    | 19.3.1     |
| Cloudflare Vite plugin   | 1.68.0     |
| Vite                     | 8.3.7      |
| Tailwind CSS             | 4.3.5      |
| Vitest                   | 4.1.12     |
| Cloudflare Vitest plugin | 1.6.1      |
| Biome                    | 2.6.6      |
| TypeScript               | 5.9.3      |
| `compatibility_date`     | 2026-11-09 |
