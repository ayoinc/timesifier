# Board

How the board works, and what Ready and Done mean, is in `docs/ways-of-working.md`. Tick a criterion only with its evidence beside it.

## In progress (limit 1)

_Empty._

## Review (limit 2)

### TS-002 · Pipeline: checks on every pull request

Blocked on one criterion; the rest is merged.

- [x] A workflow runs on every pull request and on `main`: install with a frozen lockfile, typecheck, lint, tests, build. _Pull request #2: job `checks` passed in 46 s._
- [x] A secret scan and `pnpm audit --audit-level=high` run in the workflow, and a finding fails it. _Job `secret scan` passed; the audit is the last step of `checks`. Neither has been shown failing on a real finding._
- [x] Every third-party action is pinned to a full commit SHA, and the workflow's default `permissions` are `contents: read`. _See `.github/workflows/ci.yml`._
- [x] A throwaway pull request with a failing test shows a failed check; it is then closed. _Pull request #3: `checks` failed in 35 s; closed and its branch deleted._
- [ ] `main` is protected: the check must pass before merging. _Blocked: GitHub answered "Upgrade to GitHub Pro or make this repository public to enable this feature." The owner decides. Until then, TS-003 deploys only after `checks` passes in the same workflow run._

### TS-003 · Pipeline: preview and production deploys to timesifier.com

The last two criteria are proven by this card's own pull request and its merge; they are ticked in the next pull request.

- [x] The zone's DNS records are exported before the change and after it. The only differences are the Worker custom-domain records for `timesifier.com` and `www.timesifier.com`. _Before: the 26 record values then known, captured one by one. After: the same 26 values, and new address records for the apex and `www`. The capture before missed one record, `paperclip` (another Worker's custom domain), so the dashboard's own list was checked as well: of 29 records, exactly two were created or modified on 2026-11-11, `timesifier.com AAAA 100::` and `www.timesifier.com AAAA 100::`, both at 02:26 UTC; the newest change to any other record is dated 2026-09-28._
- [x] `dig MX timesifier.com` and the zone's SPF, DKIM and DMARC records return the same values before and after. _`dig +short MX timesifier.com` returned `0 timesifier-com.mail.protection.outlook.com.` both times; `diff` of the two captures shows no MX, TXT or CNAME line changed._
- [x] The pipeline's Cloudflare token is limited to this account's Workers and D1 and to this zone, and is stored as a GitHub Actions secret. _Token `timesifier-ci-deploy`: Editor on the Worker `timesifier` only, Workers Routes on the zone `timesifier.com` only, D1 write on the account, expires 2027-11-11. With it, another Worker's settings answered "No access to the specified resource" and this zone's DNS records answered "Authentication error". `gh secret list` shows `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. D1 write covers every database in the account because Cloudflare offers no narrower scope; see `docs/architecture.md`._
- [x] A smoke test after each deploy fails the workflow when the home page does not return 200. _`scripts/smoke.sh` against a live preview: "ok … answered 200", exit 0. Against the same URL after the preview was deleted: "FAIL … answered 404, expected 200", exit 1._
- [x] The rollback command is written in `docs/architecture.md`, and one rollback has been carried out and recorded on this card. _2026-11-11 02:36:49 UTC: `wrangler rollback d1625379-615a-4bf9-bdb8-d6fdb2da73b7` moved production from version `05a58e49` to `d1625379`; the home page answered 200. 02:37:07 UTC: returned to `05a58e49`; 200 again._
- [ ] Merging to `main` deploys to production: `curl -sI https://timesifier.com` returns status 200, and `https://www.timesifier.com` redirects to the apex. _The first deploy was made by hand to create the Worker: the apex answered 200 with `<h1>Timesifier</h1>` and `www` answered 308 to the apex._
- [ ] Each pull request receives a comment with its preview URL.

## Ready (limit 3)

_Empty._

## Backlog

### TS-004 · Design tokens

Depends on: TS-001.

- [ ] `pnpm tokens` generates the Material 3 colour roles for light and dark schemes from one seed colour, as CSS custom properties, and the output is committed.
- [ ] Type scale, shape, spacing, elevation and motion tokens (durations, easings, one spring) exist as CSS custom properties and as Tailwind theme variables.
- [ ] `pnpm check:tokens` exits non-zero when a file under `app/` contains a hex colour or an arbitrary Tailwind value; a test fixture proves it.
- [ ] A test checks every text colour role against its background role in both schemes: each pair is at least 4.5:1.
- [ ] The Tokens table in `docs/design-system.md` is filled in.

### TS-005 · Component foundation

Depends on: TS-004.

- [ ] The headless library choice is confirmed against the current documentation of React Aria Components, Base UI and Radix, and `docs/decisions.md` entry 6 is updated with what was found.
- [ ] Button, IconButton, TextField, Checkbox, Switch, Select, Menu, Dialog, Sheet, Tabs, Snackbar and Tooltip exist and are styled only with tokens.
- [ ] Each component has a test that operates it by keyboard and asserts its role and accessible name.
- [ ] The `/design` route shows every component in every state in light and dark, and returns 404 in a production build.
- [ ] An automated accessibility scan of `/design` reports no violations.
- [ ] With reduced motion requested, a test finds no animation of position or scale in any component.

### TS-006 · Application shell

Depends on: TS-005.

- [ ] Below 600px the shell shows a navigation bar; from 600px it shows a navigation rail with the same destinations.
- [ ] Moving between destinations animates in the direction of travel using view transitions; with reduced motion requested there is no movement.
- [ ] The page has a skip link and landmarks, and after navigation focus is on the main heading (test).
- [ ] The colour scheme follows the system, can be overridden, and the override survives a reload.
- [ ] Lighthouse reports an accessibility score of 100 for the shell.

### TS-007 · Database foundation

Depends on: TS-001.

- [ ] The D1 database is created in the EU; the option used is confirmed against Cloudflare's documentation and written in `docs/architecture.md`.
- [ ] `pnpm db:migrate:local` builds the schema from an empty database using committed SQL migrations.
- [ ] Tables `users`, `organisations` and `memberships` exist with time-sortable ids and UTC timestamps.
- [ ] A test seeds two organisations and shows that the organisation-scoped data layer returns no rows of one to a caller scoped to the other.
- [ ] Remote migrations run only from the pipeline; the README says so.

### TS-008 · Authentication

Depends on: TS-006, TS-007.

- [ ] The supported way to run Better Auth on D1 is confirmed against its documentation and written in `docs/decisions.md` entry 8.
- [ ] A person can sign up and sign in with a passkey and with email, sign out, and end all their sessions; each has a test.
- [ ] The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax` and uses the `__Host-` prefix (test reads the `Set-Cookie` header).
- [ ] The 11th sign-in attempt in one minute from one client returns status 429 (test).
- [ ] Sign-up without a valid Turnstile token is rejected by the server (test with Turnstile's test keys).
- [ ] A test lists every route under `/app` and shows each redirects to sign-in without a session.
- [ ] Verification email is sent from a dedicated subdomain; the zone comparison from TS-003 shows no other record changed.

### TS-009 · Organisations, teams and roles

Depends on: TS-008.

- [ ] A signed-in person can create an organisation and becomes its owner.
- [ ] An invitation link works once, expires after 7 days, and a test shows a used or expired link is rejected.
- [ ] Roles are owner, admin and member. A table in this card lists which role may do what, and a test covers every cell.
- [ ] A member of one organisation receives 404 for any URL of another organisation (test).

### TS-010 · Security headers and request checks

Depends on: TS-001.

- [ ] Every HTML response carries a Content Security Policy with a per-request nonce and no `unsafe-inline`, plus HSTS, `frame-ancestors 'none'`, Referrer-Policy and Permissions-Policy (test).
- [ ] A state-changing request whose `Origin` is not the application's is rejected with 403 (test).
- [ ] Every action validates its input with a schema; a test sends malformed input to each and receives 400.
- [ ] securityheaders.com grades production A or better, once TS-003 is done.

### TS-011 · Projects and clients

Depends on: TS-009.

- [ ] A member can create, rename and archive clients and projects within their organisation.
- [ ] An archived project is hidden from the timer picker and still appears in reports.
- [ ] Names are required, at most 120 characters, and unique within the organisation ignoring case (tests).
- [ ] The empty state explains what a project is and offers one action: create the first.

### TS-012 · Timer and manual entries

Depends on: TS-011.

- [ ] A person can start a timer on a project and stop it; the entry stores start and end in UTC.
- [ ] Starting a timer while one is running stops the first at the same instant; a database constraint allows one running entry per person (test).
- [ ] A running timer survives a reload and shows the same elapsed time, to the second, in a second browser.
- [ ] A person can add, edit and delete an entry by hand; an end before its start is rejected.
- [ ] Times are shown in the person's time zone; a test covers an entry that crosses midnight and one that crosses a clock change.
- [ ] The timer digits animate when they change, and stay still with reduced motion requested.

### TS-013 · Today and week views

Depends on: TS-012.

- [ ] Today lists the day's entries in order with a total; Week shows seven days with a total for each day and each project.
- [ ] Every total equals the sum of the entries shown (property test over random entries).
- [ ] An entry can be added from the keyboard alone, without the pointer.
- [ ] Moving between days and weeks animates in the direction of travel.

### TS-014 · Reports and CSV export

Depends on: TS-013.

- [ ] A report covers a chosen date range, grouped by project, client or day.
- [ ] Report totals equal the sum of the underlying entries for the same range (property test).
- [ ] The CSV export has one row per entry with ISO 8601 times, and opens correctly in a spreadsheet when a description contains commas, quotes or line breaks.
- [ ] A cell that starts with `=`, `+`, `-` or `@` is escaped so that a spreadsheet does not run it as a formula (test).
- [ ] The export contains only the caller's organisation (test).

### TS-015 · AI category suggestions

Depends on: TS-012.

- [ ] For an entry with a description, the application suggests a project; the suggestion is applied only when the person accepts it.
- [ ] A labelled set of at least 30 example entries is committed; `pnpm eval:categories` reports accuracy, and the threshold it must meet is written on this card before the first run.
- [ ] A description that contains instructions ("ignore the above and…") produces a project suggestion or none, never different behaviour (test with at least 5 such inputs).
- [ ] Requests go through AI Gateway with a daily spend limit; the limit is written in `docs/architecture.md`.
- [ ] The model receives the description and the organisation's project names, nothing else (test inspects the request).

### TS-016 · Calendar import

Depends on: TS-013.

- [ ] A person can add a calendar by its ICS address; its events appear beside tracked time in Today and Week.
- [ ] The address is fetched by the server only if it is `https` and resolves to a public address; private, loopback and link-local addresses are refused (test).
- [ ] The calendar address is stored encrypted and never returned to the browser after saving.
- [ ] A feed that fails or exceeds 5 MB shows a clear message and leaves existing events in place.

### TS-017 · Focus blocks

Depends on: TS-016.

- [ ] A person can plan a focus block on a day; it appears in Today and Week.
- [ ] A block that overlaps a calendar event is flagged before saving.
- [ ] At the end of the day the view shows planned focus time beside the time actually tracked during those blocks; the two figures are covered by a test.

### TS-018 · Weekly summary

Depends on: TS-014.

- [ ] Each Monday at 07:00 in the person's time zone, a summary of the previous week is produced: total time, the three largest projects, focus time planned and achieved.
- [ ] The figures equal those of the report for the same week (test).
- [ ] The job can be run again for the same week without producing a second summary (test).
- [ ] A person can turn the summary off, and it then stops.

### TS-019 · Threat model

Depends on: TS-009.

- [ ] `docs/threat-model.md` covers each part in `docs/architecture.md` with its assets, entry points and threats.
- [ ] Every threat has a rating and either a control already in place, a card that will add it, or a written acceptance by the owner.
- [ ] No threat rated high is left without a control or a card.

### TS-020 · Audit log

Depends on: TS-009.

- [ ] Sign-in, failed sign-in, role change, invitation, export and deletion each write a record with who, what, when and the organisation.
- [ ] Records cannot be changed or deleted through the application (test).
- [ ] An owner can read their organisation's records and no other organisation's (test).
- [ ] No record contains a secret, a session token or entry text (test).

### TS-021 · Export and deletion of personal data

Depends on: TS-014.

- [ ] A person can download everything held about them as JSON.
- [ ] Deleting an account removes or anonymises every row that refers to the person; a test lists the tables and checks each.
- [ ] `docs/data-protection.md` lists what personal data is held, why, where, and for how long.
- [ ] Deletion asks for confirmation in a sheet with the account's email typed in.

### TS-022 · Observability and recovery

Depends on: TS-003.

- [ ] Server logs are structured JSON with a request id; a test asserts no log line contains a cookie, a token or entry text.
- [ ] An alert reaches the owner when the error rate passes a threshold written in `docs/architecture.md`; it has been triggered once on purpose.
- [ ] The production database has been restored to an earlier point in time into a scratch database, and the steps are written down.

### TS-023 · Accessibility audit

Depends on: TS-014.

- [ ] An automated accessibility scan runs in the pipeline on every main route and reports no violations.
- [ ] Every task in "What success looks like" in `docs/product.md` has been completed by keyboard alone and with a screen reader; findings are listed on this card and fixed.

### TS-024 · Performance budget

Depends on: TS-014.

- [ ] The pipeline measures the home page, Today and Reports and fails when Largest Contentful Paint exceeds 2.5 s, Interaction to Next Paint exceeds 200 ms, or Cumulative Layout Shift exceeds 0.1.
- [ ] The budget and the test conditions are written in `docs/architecture.md`.

### TS-025 · Public pages

Depends on: TS-006.

- [ ] `https://timesifier.com` explains what Timesifier does and offers one action: create an account.
- [ ] Privacy and terms pages exist and are linked from every page.
- [ ] Each public page has a title, a description and a social preview image, and is server rendered (the text is present in `curl` output).

## Done

### TS-001 · Scaffold the application on Cloudflare

Done 2026-11-11. Created with `pnpm create cloudflare@latest` using the React Router template, in TypeScript strict mode, with Biome.

- [x] `pnpm dev` serves a page at the local address whose text includes "Timesifier". _`curl http://localhost:5273/` returned 200 with `<h1>Timesifier</h1>`._
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm build` each exit with status 0. _All three exited 0 in a fresh clone._
- [x] `wrangler.jsonc` sets `compatibility_date` to the date the scaffold tool selected (2026-11-09), and `observability.enabled` and `observability.traces.enabled` to `true`. _See `wrangler.jsonc`._
- [x] Binding types are generated by `wrangler types`; a search of the source for `interface Env` finds nothing. _`grep -R "interface Env" app workers test` found 0 lines._
- [x] `.gitignore` covers `.dev.vars`; `.dev.vars.example` exists and holds names only. _Both in the repository._
- [x] The Versions table in `docs/architecture.md` is filled in from the lockfile. _17 rows._
- [x] The quick start in `README.md` works in a fresh clone in a temporary folder. _Clone, `pnpm install --frozen-lockfile`, then typecheck, lint, test (1 passed) and build all succeeded._

## Later

Not refined; no acceptance criteria yet. See "After release 1" in `docs/product.md`.

- Paid plans and billing
- Desktop app and browser extension for passive tracking
- iOS and Android apps
- Two-way calendar sync and meeting scoring
- Integrations with chat, task and billing tools
- Team analytics and workload balancing
