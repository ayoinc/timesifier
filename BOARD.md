# Board

How the board works, and what Ready and Done mean, is in `docs/ways-of-working.md`. The columns are listed nearest to done first. Only the integrator edits this file; a criterion is ticked only with its evidence beside it.

**The path.** The owner added two cards on 2026-11-11, and they come first: TS-036, one way in, and TS-037, the signed-in pages in the landing page's direction. After them the next three cards are TS-011a, TS-012a and TS-013, in that order. No card outside this path is pulled until a person can sign in for the first time, run a timer and see it in the week view in production. Three more things are named here so that nobody has to guess: the cards already in progress below finish; TS-022a is Done before TS-012a is pulled, because that is when the first data worth recovering arrives; and TS-043 is Done before TS-030 is deployed, because anyone may make an account. The cards for teams and managers, the month and year views, leave, the team calendar and policies (TS-038 to TS-042), which the owner asked for on 2026-11-11, wait behind this path.

## In progress (limit 1 per builder)

### TS-031 · Apply the review of the plan

Builder: an AI session on branch `ts-031-plan`. Six reviewers went over the architecture, the design flow and the way of working. This card applies what they found to the documents, the board and the pipeline. It changes no application code.

- [ ] TS-011a, TS-012a and TS-013 are in Ready, each with its routes, tables and columns, a role table and criteria a test can decide.
- [ ] `docs/ways-of-working.md` holds one procedure for a card, with each step given to the builder or the integrator.
- [ ] Decisions 25 (time entries) and 26 (time zone) are written in `docs/decisions.md`.
- [ ] The browser tests run in a job of their own, `browser tests`, beside `checks`; `preview` and `deploy` need both. The integrator adds `browser tests` to the checks `main` requires, in the same hour as the merge.
- [ ] A pull request whose new migration holds `DROP` or `RENAME` fails the job `migration check` unless it changes only `migrations/` and `app/db/schema.ts`.
- [ ] Done cards are in `docs/board-done.md`, and the board keeps one line for each.
- [ ] TS-036 and TS-037, which the owner asked for on 2026-11-11, are on the board with their criteria.
- [ ] `docs/ways-of-working.md` describes the goldfish review of a brief.
- [ ] `docs/product.md` describes the product as the owner described it on 2026-11-11, and TS-038 to TS-042 are in Backlog with their criteria.
- [ ] `pnpm format` and `pnpm lint` exit 0.

### TS-064 · Foundation for the business features

Builder: an AI session on branch `ts-064-foundation-b2b`. It lays what the business cards share, from `docs/research/harvest-b2b.md` (cards B3 to B22, here TS-065 to TS-084) and the owner's decisions of 2026-11-11, and builds no feature beyond an empty destination. TS-053 is its precedent. Migration `0008_business` was generated from `app/db/schema.ts` after TS-061 (migration `0007_leave`) merged.

- [x] The destinations by heading and role: Track (Timesheet, Time off, Expenses), Organize (Team, Clients, Projects, Tasks), Bill (Invoices, Estimates), Review (Approvals, Reports, Dashboards, Activity log), then Integrations and Workspace settings; a heading only with a link under it; links without Time off 4 for a member, 8 for a manager, 9 for Finance, 14 for an owner or admin (`test/pages/destinations.test.ts`).
- [x] A destination a person may not see answers the same 404 as another organisation's, for every new destination (`test/pages/destinations.test.ts`, `test/pages/isolation.test.ts`).
- [x] The navigation under 600px: Timesheet, Time off, Expenses, Projects and More, each an equal share of the bar and at least 48px tall; More a native popover under the person's headings, marked current when the page is inside it and showing the pending count; a lone item sits in the bar; "Track time" a floating button, one strip only while a timer runs, not on Timesheet (audit W03, W11; browser test).
- [x] The Finance role: given by an owner or admin, with a member's plugin permissions; and the employee or contractor flag on a membership (`app/organisations/roles.ts`, `test/organisations/permissions.test.ts`).
- [x] The access rules: `isFinance`, `maySeeRates`, `mayManageRates`, `mayInvoice`, `mayManageTasks`, `mayManageIntegrations`, `maySeeExpensesOf`, `mayChangeExpensesOf`, `activityScopeOf`, and `timeScopeOf` giving Finance everyone (`app/organisations/access.ts`, with tests).
- [x] The schema of every business card in `app/db/schema.ts`, every new table in `tenantTables` with composite references inside the organisation (`test/db/business-tables.test.ts`, once `0008` exists).
- [x] The shared rules with their tests: `app/money`, `app/rates`, `app/billing`, `app/budgets`, `app/locks`, `app/integrations`.
- [x] The activity writer, `app/activity/activity.server.ts`, called from the existing writes for entries, periods, projects, clients and members; it copies no description; records kept 730 days.
- [x] Each new destination has its heading and an empty state until its card replaces it.
- [x] `docs/navigation.md`, `docs/security.md`, `docs/architecture.md` and `docs/harvest-comparison.md` describe the destinations, roles, tables and what is taken from Harvest.
- [x] Migration `0008_business`, generated after TS-061 merged, with the trigger that refuses an UPDATE of `activity_records` added by hand. It drops and renames nothing: `time_entries` gains its three columns in place, so the CI migration check passes; applied by hand to a database holding an entry, it keeps the entry, and a new organisation still gets its leave defaults from `organisations_leave_defaults`.
- [ ] typecheck, lint, tests and the shell's browser tests pass in the pipeline.

### TS-121 · A person can see which company runs Timesifier

Builder: an AI session on branch `ts-121-company-details`, the owner's own work of 2026-11-14 (commit 15fa8a6). Pushed on 2026-11-22 with the owner's approval; it merges only after the owner has accepted the screenshots. The owner decided on 2026-11-14 who runs Timesifier (`docs/decisions.md`, entry 46), which closes the open criterion of TS-030 about who runs it. An instruction from the owner, so this card is in the pull request of the work.

**Depends on:** TS-030 (Review), whose pages and footer it changes; TS-032 (Done), whose settings it follows.
**Reference for the screen:** the footer and the sections of the two notices as TS-030 built them (`docs/design-direction.md`). It adds one paragraph to the footer and one section to each notice, and the owner reviews them before they are published.
**Owns:** `app/landing/operator.tsx`, `app/landing/Site.tsx`, `app/landing/Document.tsx`, `app/lib/deployment.ts`, `app/routes/home.tsx`, `app/routes/sign-in.tsx`, `app/routes/privacy.tsx`, `app/routes/terms.tsx`, `app/routes/auth/AuthPage.tsx`, `app/routes/auth/session.server.ts`, `scripts/deploy-config.ts`, `wrangler.jsonc`, `vitest.workers.config.ts`, `.github/workflows/ci.yml`, their tests, and the documents that describe them.
**Interfaces:** gives `deploymentOperator(env)` and `<OperatorDetails>` from `app/landing/operator.tsx`, and `operator` as a required property of `SiteFooter`, `Document` and `AuthPage`. Takes `required` from `app/lib/deployment.ts`.

- [x] The foot of `/`, `/sign-in`, `/privacy` and `/terms` states the registered name of the company the deployment names, its number, where it is registered and its registered office (`test/documents.test.ts`, "the foot of … names the company that runs this deployment, its number, where it is registered and its registered office").
- [x] The terms say which company they are with, and the privacy notice says which company answers for what is stored (`test/documents.test.ts`, "the terms say which company they are with", "the privacy notice says which company answers for what is stored"; in a browser, `e2e/documents.spec.ts`, "says which company runs Timesifier, in the page and at its foot").
- [x] No company is in the code: the four details are the settings `OPERATOR_NAME`, `OPERATOR_COMPANY_NUMBER`, `OPERATOR_REGISTERED_IN` and `OPERATOR_REGISTERED_OFFICE`, listed in `docs/security.md`, "Secrets". The pipeline refuses to deploy without each (`scripts/deploy-config.test.ts`, "with no setting at all fails, names every one, and writes nothing"), and a Worker without one serves none of the four pages (`test/deployment.test.ts`, "a Worker without the company that runs it names nobody").
- [x] The four repository variables are set in GitHub with the values of entry 46 before this card's pull request is opened: its preview and the deploy fail the settings check without them. _The integrator's or the owner's to do; evidence is the settings step passing in the pull request's run._ _Set on 2026-11-22; the settings step passed in run 45074909880, and the preview `pr-78` names the company on `/`, `/sign-in`, `/terms` and `/privacy`._
- [x] The owner has accepted screenshots of the foot of the home page and of both notices at 390px and 1280px, in both colour schemes. _The owner answered "Accepted: merge it" on 2026-11-22, of the 24 screenshots in `cmux-assets/browser/timesifier/TS-121/`._
- [ ] In production, `https://timesifier.com/terms` and `https://timesifier.com/privacy` name Virtual Concept Technologies Limited, company number 17581385. _Proven after the deploy._
- [ ] typecheck, lint and tests pass in the pipeline.

Left for the owner, not part of this card: whether the emails name the company (see "Later"), and a way to the notices from the pages that have none (see "Later").

## Review (limit 2; a card waiting only on the owner is not counted)

### TS-122 · The rest of the Harvest sweep

Builder: an AI session on branch `ts-122-sweep-rest`, pull request #91. Builds S2-07, S2-06, S2-12 and S2-09 of `research/harvest-sweep-2.md`'s top 15; S2-14, S2-13 and S2-10 are built on a branch of their own, and S2-08 (Team's week as a capacity table) waits for #84. Decision 65 is this card's. Migration `0033_pins`, renumbered at merge. Team's change is kept small, as #84 changes the same page: a pinned person is put first before #84's paging takes its page.

- [x] S2-07 · Projects shows each budget's progress for the current period, from the project page's own sums (`projectBudgets` and `budgetShownTo`): "62% of 40:00 · 15:12 left", a 4px bar, and a Sort field with "Nearest budget limit". Hours budgets go to those who oversee the work, fees budgets only to those who see rates. A budget past its alert says so in words, with no warning colour (decision 65). Tests: `test/pages/projects-budget.test.ts` (each role and stranger, the property test against the project page, the order); `e2e/sweep-rest.spec.ts`.
- [x] S2-06 · Duplicate a project from the row's Actions or from the project page: its client, settings, budget and lines, tasks, tags and rates, never its time, expenses or dates, offered as "<name> (copy)", logged as "Duplicated from" its source. Owners and admins alone; nobody else is offered it, and the server answers 403 (decision 65). Tests: `test/pages/projects-duplicate.test.ts` (copy contents, Activity, name clash, another organisation's project, owner and admin copy, Finance, manager, member and contractor refused, stranger, offered name); `e2e/sweep-rest.spec.ts`.
- [x] S2-12 · Once a week has closed, Approvals' empty Pending says "Nothing is waiting for you this week. 3 people have not submitted: Grace Hopper, Linus Torvalds and Mona Lisa." with "Show them" opening `?status=not-submitted`: the people the viewer decides, whole-week leave left out, the first four named past five. Tests: `test/pages/approvals-not-submitted.test.ts` (owner, admin, manager, whole-week leave, an open week, Finance, member, contractor and stranger, the sentence); `e2e/sweep-rest.spec.ts`.
- [x] S2-09 · Pin and Unpin in the row Actions of Projects and of Team's This week, for the person alone: pinned projects head Projects under "Pinned" and Track time's picker above Recent, pinned people head This week. The table `pins` (migration `0033_pins`, decision 65) loses a pin when the pinner or the pinned person leaves, or the project goes. By keyboard, the row's Actions keeps the focus after it moves. Tests: `test/pages/pins.test.ts` (each role and stranger on Projects and the picker, owner, admin and manager on Team, Finance, member, contractor and stranger refused, leaving, the check), `test/projects/project-picker.test.ts`; `e2e/sweep-rest.spec.ts`.
- [x] Browser spec `e2e/sweep-rest.spec.ts`: each item by keyboard, scanned with axe, at 390 and 1280 px, light and dark; screenshots in `cmux-assets/browser/timesifier/TS-122/`.

### TS-123 · The sweep's small feel details

Builder: an AI session on branch `ts-123-sweep-feel`. From `research/harvest-sweep-2.md`, S2-14, S2-13 and S2-10; decision 66. No migration. In review: the pull request against `main`.

- [x] **1. Where today is (S2-14).** The Day, Week and Calendar steppers, the day picker, the Day view's heading, the Track time sheet's date and History lead with Yesterday, Today, Tomorrow, Last/This/Next week or Last/This/Next month, in the person's zone, the dates kept beneath for every reader (`nearWord`; `test/time/format.test.ts`, "the word a period leads with", over Tokyo, London and Los Angeles across a week's end and both changes of the clocks; `test/pages/sweep-feel.test.ts`, "S2-14", per role and a stranger's 404).
- [x] **2. An unavailable action says why (S2-13).** "Copy last week with hours" and the Day view's copy are there when they cannot be used: `isUnavailable`, `aria-disabled`, kept in the focus order, described by their reason (`copyWeekRefusal`, `copyRefusal`; `test/pages/sweep-feel.test.ts`, "S2-13", per role, the week and day yet to come, and a stranger's 404; `test/pages/timesheet.test.ts`, "with nothing tracked").
- [x] **3. The menu tucks away (S2-10).** "Hide menu" in the band from 600px, or Ctrl+\ / ⌘\, folds the column to a 72px strip that keeps a running timer stoppable; the page's column takes the page's width; kept per browser in `__Host-menu`, read on the server; a form that works without script (`/app/<slug>/menu`); 200ms on `motion-safe:` only; the focus on a link that leaves goes to the toggle (`test/pages/sweep-feel.test.ts`, "S2-10", per role, the way back kept inside the organisation, and a stranger's 404; `test/action-validation.test.ts`).
- [x] **4. Decision 66**, `docs/design-system.md`, `docs/navigation.md`, `docs/security.md` ("The menu cookie").
- [x] **5. Browser spec.** Keyboard and axe at 390 and 1280px in both schemes; the strip's 72px and the wider column at 1280px, a reload that arrives hidden, a timer stopped from the strip, the shortcut and the focus, and no transition with reduced motion (`e2e/sweep-feel.spec.ts`); screenshots in `cmux-assets/browser/timesifier/TS-123/`.
- [ ] typecheck, lint, tests and the browser tests pass in the pipeline.

### TS-125 · Team's week as a capacity table

Builder: an AI session on branch `ts-125-capacity`. S2-08 of `research/harvest-sweep-2.md`, the last of its top 15; decision 70. No migration. In review: pull request #104.

- [x] **1. The table.** Each person on This week has their logged time (overtime apart), the time expected of them from their schedule less public holidays and approved leave, a bar of logged against expected with leave hatched and the time over in the error colour, and "3:45 under · 89% of capacity" in words; a headline "103:30 of 198:45 expected" leads (`test/pages/capacity.test.ts`, "gives each person their week's expected hours, logged hours, and where they stand", "draws each week as a meter that reads out its figures, leave hatched, overtime past the end", "takes a public holiday off everyone's week, part time or not").
- [x] **2. The headline equals the sum of the rows, and each row's expected equals Reports' for that person and week** (`test/pages/capacity.test.ts`, "leads with a headline that is the sum of the rows, each row's expected the same as Reports'").
- [x] **3. Leave shortens the expected week by its hours** (half a day: 33:45 expected, 3:45 hatched; `test/pages/capacity.test.ts`, "gives each person…" and "draws each week as a meter…").
- [x] **4. Sorted by Name, Most logged, Most of capacity and Most remaining, in `?sort=`**, kept by the week's arrows, the pages and the search; "Most remaining" is expected − logged, most first (`test/pages/capacity.test.ts`, "order by name, logged, share and remaining, ties kept by name", "orders the people by each key, kept in the address").
- [x] **5. Who sees whom as before**: owner and admin everybody, a manager their teams' people, Finance, member, contractor and stranger 404 (`test/pages/capacity.test.ts`, "who sees whom").
- [x] **6. #84's paging and #91's pins together**: everyone the search keeps is ordered before the page of 50 is taken, the pinned first on page 1 (`test/pages/capacity.test.ts`, "sorts all of them before taking a page, the pins first on page 1").
- [x] **7. The figures are #84's SQL sums**: one `SUM … GROUP BY user_id` for the rows, the order and the total, no entry read row by row, the same statements for any order or page (`test/pages/capacity.test.ts`, "adds up everyone's week in SQL, however many pages or whatever order"; `test/organisations/request-memo.test.ts`, Team 36 → 35 statements).
- [x] **8. Decision 70**, `docs/architecture.md`, `docs/navigation.md`.
- [x] **9. Browser spec.** Keyboard Sort and the week's arrows, axe at 390 and 1280 px in both schemes (`e2e/capacity.spec.ts`); screenshots in `cmux-assets/browser/timesifier/TS-125/`.
- [ ] typecheck, lint, tests and the browser tests pass in the pipeline.

### TS-106 · Buyer pages

Builder: AI session on branch `ts-106-buyer-pages`. In review: the pull request against `main`. No migration. Spec: `research/corporate/cards.md`, TS-106, built to the owner's answers 8, 9 and 10 of 23 November 2026. Decision 64.

- [x] `/features`: a section per capability (Time and the timer, Timesheets and approvals, Leave, Expenses and receipts, Invoices and estimates, Reports, Roles and the activity log, Integrations), each naming the destinations it is done in (`test/claims.test.ts`, "every capability on the features page is a destination of the application", "the features page counts and lists what the application holds").
- [x] Its drawings say "Example" (`e2e/buyer-pages.spec.ts`, "every drawing on the features page that shows a time says it is an example").
- [x] `/integrations`: the API, webhooks, calendar feeds, the CSV import and export, and the Xero CSV, with the code's own limits (`test/claims.test.ts`, "the integrations page states the limits the code enforces").
- [x] `/developers/api` is `docs/api.md`, drawn at build (`test/claims.test.ts`, "the published API reference is docs/api.md").
- [x] `/api/v1/openapi.yaml` answers without a token, and documents every API route and no other (`test/integrations/api.test.ts`, "the OpenAPI document is public", "documents every route the API answers"); `/work_days` added.
- [x] `/contact`: `mailto:hello@`, `privacy@` and `security@`, the company's details from its settings, no form, no promised time (`test/claims.test.ts`, "the contact page gives the company's details…").
- [x] `/pricing`: the plans and seats from `PLAN_DETAILS`, the prices from `PRICES`, GBP excluding VAT, free until payment opens with 30 days' notice, no badge (`test/claims.test.ts`, "the pricing page's seats are the plans' seats…").
- [x] Each line on `/pricing` names a built capability; company sign-in reads "Company sign-in, available soon" where no provider is configured, and names only the configured providers once one is (`test/claims.test.ts`, "each line on the pricing page names a built capability…", "the pricing page's company sign-in is what this deployment offers…").
- [x] The terms' Price section says the same, from the same prices, in a new version of 23 November 2026 (`test/documents.test.ts`, "the terms' Price section says what the pricing page says").
- [x] The band leads to Features and Pricing; the foot groups Notices, Product and Company; every page is in the sitemap with its canonical link and description (`e2e/buyer-pages.spec.ts`; `test/claims.test.ts`, "the sitemap lists exactly the public pages…", "each public page names itself…"; `test/documents.test.ts`, the foot of every public page).
- [x] No accessibility violations at 390 and 1280px in both schemes, nothing runs off the side, nothing moves with reduced motion, pricing works without script (`e2e/buyer-pages.spec.ts`).
- [x] The owner approves the terms' new Price text (quoted in the pull request). _Approved: the owner's form answer, 23 Nov 2026._
- [x] The owner accepts the screenshots (`cmux-assets/browser/timesifier/TS-106/`). _Accepted: the owner's form answer, 23 Nov 2026._
- [ ] **Owner (106a):** the Search Console Domain property verified by DNS TXT, the sitemap submitted, Bing imported from Search Console (steps in the pull request).

### TS-105 · Trust centre

Builder: AI sessions on branch `ts-105-trust`, pull request #86 (slices 105a–105c); slice 105d, the data processing agreement, on `ts-105-dpa`, pull request #90, stacked on it. The owner's answers of 23 November 2026 (`research/corporate/cards.md`, TS-105). No migration in #86; #90 adds migration 0029, which only adds columns. Decisions 59 and 60.

- [x] `/.well-known/security.txt` answers in plain text with one `Contact`, `Expires`, `Canonical`, `Policy` and `Preferred-Languages` (`test/trust.test.ts`, "security.txt has the fields RFC 9116 requires, once each").
- [x] Its `Expires` is within a year, and the test fails 30 days before it passes (`test/trust.test.ts`, "security.txt expires within a year and is renewed a month before").
- [x] Its `Policy` reaches `/security#reporting`, which names the same address (`test/trust.test.ts`, "its Policy is the security page's part on reporting…").
- [x] `/accessibility` states WCAG 2.2 AA, the browsers the tests use, read from `playwright.config.ts`, that no independent audit has been done, how to ask for help, and its date (`test/claims.test.ts`, "the accessibility statement names the browsers and the standard the tests use"); it passes axe at 390px and 1280px in both schemes (`e2e/documents.spec.ts`).
- [x] `/security` says where data lives in the same words as `/` and `/privacy` (`test/claims.test.ts`, the three location claims, now over `/security` as well).
- [x] Encryption at rest and in transit, and the secrets kept only as keyed hashes (`test/claims.test.ts`, "the security page's hashed secrets are the ones docs/security.md lists, and the code hashes them so").
- [x] Who sees what, through the notice's own component (`test/claims.test.ts`, "Who sees what names every role…", over both pages).
- [x] The activity log is only added to, and kept 730 days (`test/claims.test.ts`, "the notice says activity records are deleted after the retention the daily job applies", over both pages).
- [x] Backups: any minute of the last 30 days, from `TIME_TRAVEL_DAYS`, and no restore claimed (`test/claims.test.ts`, "both pages state the restore window from one constant, and no restore is claimed until one is rehearsed").
- [x] How long each thing is kept, each from its constant, `SIGN_IN_DAYS` now one (`test/claims.test.ts`, "the security page says how long each thing is kept from the constant that keeps it").
- [x] Sub-processors from `SUB_PROCESSORS`, each with its agreement, the notice naming the same, and every binding in `wrangler.jsonc` belonging to one (`test/claims.test.ts`, "the sub-processors on /security are the ones the notice names…").
- [x] What is not done, and where to report a vulnerability (`test/claims.test.ts`, "the security page says what is not done, and where to report a vulnerability").
- [x] The ICO registration shows only from `OPERATOR_ICO_REFERENCE` (`test/documents.test.ts`, "the ICO reference is the setting's" and "without the setting, no page says anything of the ICO"; `scripts/deploy-config.test.ts`; `test/deployment.test.ts`).
- [x] The foot's notices gain Security and Accessibility; the sitemap lists both; a public page links only to public pages and to `OUTSIDE_LINKS`, each matched whole (`test/claims.test.ts`, "the sitemap lists exactly the public pages…"; `e2e/public-links.spec.ts`; `e2e/one-way-in.spec.ts`).
- [x] The owner accepts the screenshots of `/security` and `/accessibility` at 390px and 1280px, in both schemes (`cmux-assets/browser/timesifier/TS-105/`). _Accepted: the owner's form answer, 23 Nov 2026._
- [x] `/dpa` states the Article 28(3) terms, with its sub-processors from `SUB_PROCESSORS`, the 48-hour breach notice and the 30 days' notice of a new sub-processor from `BREACH_NOTICE_HOURS` and `SUB_PROCESSOR_NOTICE_DAYS`, and where the data is kept in the same words as the other pages (`test/claims.test.ts`, "the sub-processors on /security and /dpa…", "the data processing agreement gives the owner's notice periods from their constants", and the three location claims, now over `/dpa` as well); it passes axe at 390px and 1280px in both schemes, and its links all lead somewhere (`e2e/documents.spec.ts`, `e2e/public-links.spec.ts`).
- [x] The terms incorporate it, in "Processing your organisation's data"; a signed copy is on request; the foot's notices and the sitemap gain it (`test/documents.test.ts`).
- [x] The privacy notice's `#who-we-are` names each organisation the controller of its people's work data and the company its processor (`test/documents.test.ts`).
- [x] Creating an organisation says "By creating it you accept the terms and the data processing agreement for it", with both links, and is refused with `DPA_NOT_ACCEPTED` without the current version; the organisation keeps who accepted, when, and which version (`test/organisations/terms-acceptance.test.ts`, "creating an organisation").
- [x] An owner of an organisation that has not accepted this version is asked once, at the top of Workspace settings, until one owner accepts; nobody else is asked, every other role and a stranger is refused, and nothing waits on it (`test/organisations/terms-acceptance.test.ts`; `e2e/dpa-acceptance.spec.ts`, with axe at 390px and 1280px: a journey of the organisations', in a file of its own because it writes to the database and so runs with the seeded tests). Creating an organisation names both documents, each a link the keyboard reaches before the action (`e2e/organisations-keyboard.spec.ts`).
- [x] Each acceptance is a `dpa.accepted` record in the activity log, with the version (`test/organisations/terms-acceptance.test.ts`, "the activity log").
- [x] The owner approves the text of `/dpa` before it goes live. _Approved: the owner's form answer, 23 Nov 2026._
- [x] The owner accepts the screenshots of `/dpa` and of the ask in Settings at 390px and 1280px, in both schemes (`cmux-assets/browser/timesifier/TS-105/`). _Accepted: the owner's form answer, 23 Nov 2026._
- [ ] typecheck, lint and tests pass in the pipeline.

### TS-107 · Monitoring and status

Branch `ts-107-monitoring`. Decision 61; `docs/operations.md`. Status repository: https://github.com/ayoinc/timesifier-status.

- [x] `GET` or `HEAD` `/health` answers `200 {"status":"ok","database":"ok","files":"ok"}` when D1 and R2 answer. _`test/health.test.ts`, "health answers ok when the database and the files answer"._
- [x] Otherwise `503`, naming the part that failed and nothing more. _Same file, "health answers 503 naming the part that failed: the database" and "…: the files"._
- [x] It reads no row, writes nothing, sets no cookie and is `no-store`. _Same file, "reads no row and writes nothing…" and the first test._
- [x] A second check within 30 seconds reaches neither D1 nor R2. _Same file, "a second check within 30 seconds reaches neither D1 nor R2"._
- [x] `scripts/smoke.sh` requires `/health` to answer `200 ok` after every deploy. _The script; it runs in CI after each preview and production deploy._
- [x] The status repository checks `/health` and the four public pages every 5 minutes on `GITHUB_TOKEN`, and an outage opens an issue. _Its Uptime CI runs; issue #1 opened while `/health` did not exist yet in production._
- [x] The footer links to the status page under Company, through `OUTSIDE_LINKS`: the repository's page until `status.timesifier.com` resolves (on 2026-11-23 Cloudflare's name server still answered NXDOMAIN and Pages had no certificate). _`test/claims.test.ts`, "the sitemap lists exactly the public pages…"; `e2e/browser-errors.spec.ts`, "links to the status page under Company", at 390 and 1280 px with axe._
- [x] An uncaught error sends exactly one report, of exactly `kind`, `name`, `route`, `frame`, `release` and `time`, holding neither the address nor the message. _`e2e/browser-errors.spec.ts`, "sends exactly one report per distinct error…"._
- [x] The handler logs one line and never reads the session. It answers 204, or 400 to a body over the limit or anything not in the schema. _`test/browser-errors.test.ts`._
- [x] Above 20 a minute from one client, nothing more is logged. _Same file, "logs at most 20 reports a minute from one client…"._
- [x] A CSP report keeps only the four fields. _Same file, "keeps only the directive, the blocked origin, the script and the line"._
- [x] Every response carries `Reporting-Endpoints` and a CSP with `report-to csp`. _`test/browser-policy.test.ts`; `public/_headers`._
- [x] The privacy notice names the report's fields from the same constants. _`test/claims.test.ts`, "the notice names exactly the fields a browser error report carries"._
- [ ] Owner: the DNS record `status` → `ayoinc.github.io`, then Enforce HTTPS (`docs/operations.md`). The owner reports it added; on 2026-11-23 `elias.ns.cloudflare.com` still answered NXDOMAIN for `status.timesifier.com`. Once it resolves and has a certificate, `OUTSIDE_LINKS.status` moves to `https://status.timesifier.com/`.
- [ ] Owner: UptimeRobot's two monitors and the drill, with its date (`docs/operations.md`).
- [ ] Owner: the four Cloudflare Monitors and the drill, with its date (`docs/operations.md`).
- [x] Owner accepted the footer and notice screenshots (`cmux-assets/browser/timesifier/TS-107/`): the owner's form, about 10:45 UTC on 2026-11-23, "Screenshots accepted".

### TS-104 · Company sign-in

Builder: AI sessions on branch `ts-104-company-sign-in`. From `research/corporate/cards.md` › TS-104 and the owner's answers 6 and 7 there. In review: pull request #89 against `main`; Google and Microsoft are offered only once the owner has created the two clients (steps in the pull request). Migration `0030_company_sign_in.sql`. Decisions 62 and 63 (entry 23 reads "Amended by 62"); `docs/security.md` (21 endpoints, company sign-in, the four provider settings). Slice 104d, SAML or OIDC per organisation, waits for a customer who asks (question 8).

**104a · Sign in with Google or Microsoft**

- [x] "Sign in with Google" and "Sign in with Microsoft" stand under the email field, each only where its client ID and secret are both set, so never on a preview (`test/auth/social.test.ts`, "appear only where the client is configured, each with its provider's mark", "a provider whose ID is set without its secret, or its secret without its ID, is not offered").
- [x] A button asks `POST /api/auth/sign-in/social` for the provider's address, carrying the state in a `__Host-` cookie; another provider, an ID token from the browser, extra scopes, a login hint or a return to another site are refused (same file, "answers with the provider's address, carrying the state, and sets the state cookie", "refuses …"); without the state cookie of the browser that asked, nobody is signed in ("without the state cookie of the browser that asked, signs nobody in").
- [x] Google signs a new person in, verified, and a returning one into the same account by Google's account id (same file, "signs a new person in, verified, with the Workspace domain on the session", "returns to the same account next time, by the account's id at Google"); any Google account may, a personal one with no domain on its session ("a personal Google account signs in, with no domain on the session").
- [x] A person made by code who signs in with Google at the same address lands in the same account (same file, "a person made by code who signs in with Google at the same address lands in the same account").
- [x] An address counts only when the provider vouches for it: one Google does not say is verified signs nobody in, makes nobody and links to nobody (same file, "an address Google does not say is verified …"); Microsoft links to a person made by code only on `xms_edov` or `email_verified`, and otherwise links to nothing and makes nobody ("links to a person made by code when Microsoft says the domain is verified", "an unverified Microsoft address links to nothing, and makes nobody"; the claims alone in "the rules, on the claims alone").
- [x] Microsoft takes work and school accounts only: a work account signs in with its tenant on the session ("signs a work account in, with its tenant on the session"); a personal account, by the personal tenant or with no tenant, is refused with words that point to the code and writes nothing; so is a token whose issuer is not its own tenant's ("a token whose issuer is not the tenant it names …", "Microsoft: `tid` is believed only from …"), and an account linked before is refused once it is in the personal tenant (same file, "refuses a personal account …", "an account linked before is refused once it is in the personal tenant"). Were the refusal bypassed, the user hook still writes nobody verified and links to nobody (`test/auth/social-unrefused.test.ts`).
- [x] No provider token is kept and no picture: the `accounts` row holds the provider and the account id, its tokens null (`test/auth/social.test.ts`, "no provider token is stored" for each provider, "keeps no picture from Google"); the privacy notice says so (`test/claims.test.ts`, "the notice says no token from Google or Microsoft is kept, as the account hooks make sure").
- [x] Every session records how it was made, `code`, `google` or `microsoft`, with Google's `hd` or Microsoft's `tid`; each sign-in in the history records its method (`test/auth/social.test.ts`, the sessions above; `test/platform/closed-account.test.ts`, "keeps each sign-in with the browser's kind, and nothing finer"), and the console's Sign-ins list says "with Microsoft" or "with a code" beside the device (`test/platform/console-accounts.test.ts`, "says beside each sign-in how it was made").
- [x] The callback answers with the security headers and a session cookie with every flag (`test/auth/social.test.ts`, "from %s carries the security headers, and a session cookie with every flag").
- [x] `POST /sign-in/social`, `GET /callback/google` and `GET /callback/microsoft` are offered, each with a rate-limit rule, 21 in all, and `docs/security.md` says 21 (`test/auth/endpoints.test.ts`, "are these 21 and no other").
- [x] The state cookie is in the privacy notice, six cookies in all (`test/claims.test.ts`, "signing in with Google or Microsoft sets no cookie the notice does not list", "the privacy notice lists every cookie the application sets, and counts them").
- [x] "Who else handles it" names Google and Microsoft, as learning that you signed in to Timesifier, only where this deployment offers them (`test/claims.test.ts`, "the notice names Google and Microsoft under who else handles it only where this deployment offers them").
- [x] Production is given a provider's client ID where its GitHub variable is set, a preview neither, and a malformed ID stops the deploy (`scripts/deploy-config.test.ts`, "gives production a provider's client ID where one is set, and a preview neither", "refuses GOOGLE_CLIENT_ID …", "refuses MICROSOFT_CLIENT_ID …"); the committed `wrangler.jsonc` names no client ("names no host, no key and no address of one …").

**104b · Require company sign-in**

- [x] Settings › Sign-in (`/app/<slug>/settings/sign-in`) opens for owners, with the domains section, and for admins, without it; it is a 404 to Finance, a manager, a member, a contractor, a stranger, and the owner of another organisation (`test/organisations/company-sign-in.test.ts`, "opens for an owner, with the domains section, and for an admin, without it", "is a 404 for Finance, a manager, a member, a contractor and a stranger, to open and to post", "is a 404 to the owner of another organisation …"; the role table in `test/pages/finance.test.ts`; `test/pages/isolation.test.ts`; `test/action-validation.test.ts`).
- [x] A change cannot lock out the person making it: an owner signed in by code may require Microsoft, since owners are exempt; an admin signed in by code may not; an admin signed in with Microsoft may, at their own tenant and not another; a provider this deployment does not offer cannot be required (same file, "an owner signed in by code may require Microsoft …", "an admin signed in by code cannot require Microsoft …", "an admin signed in with Microsoft may require it, at their own tenant and not another", "a provider this deployment does not offer cannot be required, and a tenant must be one").
- [x] With Microsoft required, a member signed in by code gets 403 on every page of Acme, its data and its forms, and the page reads "Acme asks you to sign in with Microsoft" with the one button, or says the deployment does not offer it (same file, "every page of Acme, its data and its forms answer a member signed in by code with 403", "the page says who asks, for which sign-in, and offers the one button", "where the deployment does not offer the provider, the page says so and has no button").
- [x] A membership is read only through the policy (`requireMembershipOf`; `test/organisations/membership.test.ts`); a policy naming a provider the code does not know is locked to the owners, not open (`test/organisations/company-sign-in.test.ts`, "a provider this code does not know locks Acme to its owners …", "the policy a row holds"); Settings › Sign-in says why to name a Workspace domain or tenant, and saves without one ("an owner may require Google at no Workspace domain, and the page says why to name one").
- [x] Every role but owner is held to it; a member signed in with Microsoft at the tenant gets in, at another tenant or with Google does not; a stranger and a member of another organisation get a 404 (same file, "each role but owner is held to it …", "a member signed in with Microsoft at the tenant opens it …", "tells a stranger, and a member of another organisation, nothing: a 404").
- [x] The emailed code still signs the member in to Timesifier and opens `/app` (same file, "still lets the member sign in to Timesifier by code, and open /app").
- [x] The organisation API is held to it, 403 `COMPANY_SIGN_IN_REQUIRED`; API tokens and calendar feeds keep working (same file, "holds the organisation API to it too …", "leaves API tokens and calendar feeds working: neither is a session").
- [x] Each change of policy is in the Activity log, before and after, and choosing the policy in force records nothing (same file, "is recorded in the Activity log, before and after", "choosing the policy already in force records nothing").

**104c · Verified domains**

- [x] An owner adds `acme.com` and is shown `_timesifier.acme.com TXT "timesifier-verification=<token>"`; Check looks it up over DNS over HTTPS and verifies the domain; a record with another token, or a failed lookup, verifies nothing (`test/organisations/domains.test.ts`, "shows the owner the TXT record to add, and Check finds it and verifies the domain", "a record with another token, or a lookup that fails, verifies nothing").
- [x] Free mail domains and names that are not domains are refused; a domain is added once to an organisation, and one another organisation has verified cannot be verified for a second (same file, "refuses a free mail domain, and a name that is not a domain", "adds a domain once to an organisation", "a domain another organisation has verified cannot be verified for a second: no squatting").
- [x] The daily job (`17 3 * * *`) re-checks every domain: the owners get one email after 7 days without the record, the domain is unverified after 14, a failed lookup counts toward both, and a record missing a second time is told of again (same file, "emails the owners once after 7 days without the record, and unverifies after 14", "failed lookups count toward unverifying …", "a record that goes missing a second time is told of again").
- [x] With joining on, a person whose verified address is at the domain sees "Join Acme" on `/app` and joins as a member; nobody joins while it is off, by an unverified address or at another domain; a full organisation is not joined and the person is told so; removing the domain ends joining by it (same file, "a person whose verified address is at the domain sees Join Acme and joins as a member", "nobody joins while joining is off …", "an organisation with no free seat is not joined …", "removing a domain ends joining by it").
- [x] Joining asks for fresh proof of the address, a code within 15 minutes, Google at the address's own Workspace domain, or Microsoft; a person removed is not offered Join until invited again; two people joining for the last seat cannot both have it; a domain whose record was last seen more than 48 hours ago is not joined by (same file, "proof of the address …", "a code session older than 15 minutes proves nothing now …", "a person removed from Acme is not offered Join …", "two people joining for the last seat …", "a verified domain whose record was last seen more than 48 hours ago is not joined by").
- [x] The domain actions are the owners' alone, and an owner of another organisation cannot reach Acme's domains (same file, "are the owners' alone …", "an owner of another organisation cannot reach Acme's domains through their own").
- [x] Deleting an organisation deletes its domains, and the notice says what the table holds (`test/claims.test.ts`, "deleting an organisation deletes everything in it …", "the privacy notice says what every table holds …").

**In the browser**

- [x] The sign-in page with both buttons, Settings › Sign-in, its domains section, and the "asks you to sign in" page pass axe at 390px and 1280px in both schemes (`e2e/company-sign-in.spec.ts`); screenshots in `cmux-assets/browser/timesifier/TS-104/`.
- [x] Follow-up, stacked on #89: the buttons read "Sign in with Google" and "Sign in with Microsoft" and carry each provider's own mark, inline, in the colours its branding guidelines fix for light and dark, as brand-mark tokens (decision 62, note of 2026-11-23); "Work or school account" stands under Microsoft's and describes it. Each mark is hidden from assistive technology; the marks appear only where the provider is configured (`test/auth/social.test.ts`, "appear only where the client is configured, each with its provider's mark"); each button's colours, light and dark, and Microsoft's description are checked in the browser (`e2e/company-sign-in.spec.ts`) and its words' contrast in `scripts/tokens.test.ts` ("brand marks"); screenshots `sign-in-logos-{390,1280}-{light,dark}.png`.
- [ ] typecheck, lint and tests pass in the pipeline.

**The owner's**

- [ ] Creates the Google OAuth client and the Entra app registration (with the optional claims `email` and `xms_edov`), as the pull request lists.
- [ ] Sets the repository variables `GOOGLE_CLIENT_ID` and `MICROSOFT_CLIENT_ID`, and the secrets with `wrangler secret put GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_SECRET`.
- [ ] Accepts the card.

### TS-103 · The public pages at their best

Builder: AI sessions on branch `ts-103-marketing`. The owner: "marketing on the side we'll beautify it". In review: the pull request against `main`; verifying the site in Google Search Console and Bing Webmaster Tools needs the owner (steps in the pull request). No migration. `docs/design-system.md` ("Pages outside the shell"), decision 43.

- [x] A section that runs the width of the page opens with its heading at the left and its lead at the right from 840px; the privacy section's photograph stays beside its facts while they are read (`SectionHead`, `app/routes/home.tsx`; screenshots in `cmux-assets/browser/timesifier/TS-103/`).
- [x] A section's opening words rise into place with the scrolling, by transform and opacity only, and stand still with reduced motion (`rise` in `app/landing/public.css`; `e2e/landing.spec.ts`, "with reduced motion asked for", and "nothing on the page moves when its images arrive").
- [x] "Start tracking" and "Sign in" have hover, focus and press states on the sheet, and give under the press where motion is allowed (`press` in `app/landing/public.css`; `e2e/auth-accessibility.spec.ts`, nothing transitions with reduced motion).
- [x] Text selected on the sheet shows, in both schemes (`.bg-sheet ::selection`).
- [x] The notices list their parts under the title, and each part's heading stays in the margin while it is read (`app/landing/Document.tsx`; `e2e/documents.spec.ts`).
- [x] The foot on a surface of its own: the lockup, the notices side by side on a phone, the credits in words (`SiteFooter`; `test/claims.test.ts`, "each photographer is named once").
- [x] Sign-in no longer shifts as Turnstile arrives: its empty frame is out of the flow until it asks the person something (`app/routes/auth/RobotCheck.tsx`; Lighthouse CLS 0.013 → 0).
- [x] `/sitemap.xml` lists exactly the public pages, which link only to one another; `robots.txt` is the application's and names it (`test/claims.test.ts`, "the sitemap lists exactly the public pages").
- [x] Every public page has a canonical link, its own `og:url` and a description, `/sign-in` included (`test/claims.test.ts`, "each public page names itself as its canonical address").
- [x] JSON-LD `Organization` (name, address, logo) and `SoftwareApplication`, no price and no rating (`test/claims.test.ts`, "the structured data parses"; `test/browser-policy.test.ts`).
- [x] Lighthouse 13.6.0 on the local production build, mobile, compressed as the edge sends it: 100 in performance, accessibility, best practices and SEO on all four pages; uncompressed, `vite preview` costs the home page 4 points of performance on `main` and here alike (table in the pull request).
- [ ] The owner verifies the site in Google Search Console and Bing Webmaster Tools and submits the sitemap.

### TS-100 · The brand everywhere

Builder: AI sessions on branch `ts-100-brand`. Decided by the owner on 2026-11-12 (`docs/decisions.md` entry 38). Migration `0020_brand`; R2 binding `BRAND` (buckets `timesifier-brand` and `timesifier-brand-preview`, `eu`). In review: the pull request against `main`. The platform console's page for the platform brand is TS-099's.

- [x] **1. Every email shows a logo and fetches nothing.** Every message is built by `compose`; its images are attached inline as PNG or JPEG and named by Content-ID, so no `src` is an http(s) or data address; the platform's messages carry its logo and name, the sign-in code no link (`test/auth/email-frame.test.ts`, `test/auth/email.test.ts`, `test/brand/documents.test.ts` "every message the application sends", `test/organisations/invitations.test.ts`, `test/integrations/webhooks.test.ts`). The privacy notice says so, tied in `test/claims.test.ts`.
- [x] **2. Organisation first.** Invoice and estimate PDFs carry the organisation's logo on a band of its colour, name it as `/Author`, and say "Made with Timesifier" beside the mark at the foot of every page; the message that carries one leads with the organisation's logo, attached inline (the PNG drawn from an SVG, never the SVG), name and colour; the estimate's page leads with the organisation (`test/brand/documents.test.ts`, `test/brand/logo.test.ts` "where the logo is shown").
- [x] **3. Workspace settings › Brand.** Owners and admins upload, replace and remove a PNG, JPEG, WebP or SVG logo and set a colour; a member, Finance, a manager, a contractor and a stranger get 404 and nothing is stored; a file of the wrong kind, too large, too small or an SVG that could do more than draw is refused with why; a colour white words do not read on at 4.5 to 1 is refused; each change is `brand.changed` on the Activity log (`test/brand/logo.test.ts`, `test/brand/images.test.ts`).
- [x] **4. The logo in the product.** It stands in the band of every page for every member, at an address that changes with each upload; `/app/<slug>/logo` answers members only, `/estimate/<id>/<token>/logo` only with the estimate's own token (`test/brand/logo.test.ts`; the logo route has its row in the role table, `test/pages/finance.test.ts`, and is asked for by `test/pages/isolation.test.ts` and `test/auth/guard.test.ts` once the organisation has a logo, `NEEDS` in `test/routes.ts`).
- [x] **5. The platform brand.** `platform_brand` starts at what the product said before and equals the built-in brand; a change is validated field by field (header-safe sender name, one Reply-To, single lines, `#rrggbb`, PNGs of at most 64 KB and 16 to 1024 px) and every message then carries it (`test/brand/platform-brand.test.ts`).
- [x] **6. Deleting an organisation deletes its logos** in `BRAND` first; when a delete fails the organisation is kept and says so, and asking again finishes it (`test/brand/logo.test.ts` "deleting the organisation").
- [x] **7. Exports named for the organisation.** Internal exports are named for the organisation's name, slugged, and the day they were exported ("acme-co-time-2026-11-02-to-2026-11-08-exported-2026-11-13.csv"); the all-invoices ZIP carries an archive comment saying the same; the CSVs' contents are unchanged (`test/organisations/export-filename.test.ts`, `test/integrations/invoice-export.test.ts`, the export tests of Reports, Contractors, Activity, Xero and Integrations).
- [x] **8. Docs.** `docs/design-direction.md` ("The mark", "Email"), `docs/security.md` ("Email", "Organisation logos"), `docs/architecture.md` (R2, routes, tables), README bucket commands, decision 38.
- [x] **9. Browser spec.** Workspace settings › Brand by keyboard: a PNG uploaded and saved, a colour typed with its preview saying "Too light" then "Dark enough" before it is saved, the logo in the band on this page and the next, then removed; axe on the page and both sheets at 390px and 1280px in both schemes, with the band showing the logo (`e2e/brand.spec.ts`). An invoice PDF's first page and its email, and the sign-in code email, were seen at 1280px; the PDF's bold headings were measured in Helvetica's regular widths and stood past their column's edge, now measured in Helvetica-Bold's (`app/invoices/pdf.ts`; `test/billing/documents.test.ts` "ends a bold heading on its column's right edge").
- [ ] typecheck, lint, tests and the browser tests pass in the pipeline; the buckets exist in production (owner).

### TS-084 · B3 · Leave in reports and capacity

Builder: an AI session on branch `ts-b2b-review`. In review: the pull request against `main`. Migration `0015_project_dates` adds project start and end dates, for fixed-fee spreading.

Depends on: TS-064, TS-061 (TS-042, B1), TS-014a.

- [x] Reports has a Leave view: allowance, taken, booked, pending and remaining per person and type for the leave year, with a CSV export of one row per person per type (`test/pages/report-views.test.ts`, "Leave balances": per role, and the CSV totals equal the screen).
- [x] A person's expected hours for a week are their capacity (B1) less approved leave and holidays in that week. Team's week shows "Expected", "Leave" and "Logged" (`test/pages/report-views.test.ts`, "Team's week": 3 days of leave in a 5-day week, 15:00 of 37:30).
- [ ] The research's ICS feed of approved leave is built by TS-089, which also carries entries.

### TS-074 · B11 · Sending, tax, payments and receivables

Depends on: TS-064, TS-073, TS-043 (the email ceiling).

Built with TS-073 on `ts-b2b-bill` (PR #46).

- [x] Organisation invoice settings: legal name, address, tax registration number, default payment terms (on receipt, Net 15/30/45/60, custom days), default notes, and up to two taxes (simple or compound). Per invoice: PO number, discount %, and per-line choice of taxes (tests with UK VAT 20% and a compound case). (`/invoices/settings`; `test/billing/documents.test.ts` "keeps the organisation's details…", "holds at most two taxes at once", "UK VAT at 20%…", "a compound tax is charged on the line plus its simple tax…")
- [x] Totals are computed in integer minor units with one documented rounding rule (round half up per tax line). Subtotal − discount + tax = total for random invoices (property test). (`app/money`; `test/billing/invoices.test.ts` "property: stored totals are app/money's, subtotal − discount + tax = total"; `test/money/money.test.ts`)
- [ ] Issuing turns draft into open and fixes the number, the issue date and the due date. An open invoice's lines cannot change; it can only be voided, which releases its entries, or credited (test). Built and tested except the credit note: issuing, the lines fixed by trigger, voiding that releases (`test/billing/invoices.test.ts` "an issued invoice's lines do not change", "is locked while on an invoice…"); a credit note is not built.
- [x] A PDF of the invoice is produced on the Worker, and its numbers equal the screen's (test comparing extracted text). (`app/invoices/pdf.ts`; `test/billing/documents.test.ts` "prints the numbers the page shows", GBP and de-DE EUR; `test/billing/invoices.test.ts` "the PDF")
- [x] Send by email to the client's billing contacts, with the PDF and a template subject and body holding the invoice variables. Every send is logged on the invoice's history (test against the email adapter). (`test/billing/documents.test.ts` "goes to each billing contact with the PDF, and is logged on the invoice's history")
- [x] Record a payment (date, amount, note); partial payments leave a balance; the payment can be deleted; part or all can be written off. Status is open, partly paid, paid or written off, from the payments (property test: balance = total − payments − write-offs ≥ 0). (`test/billing/invoices.test.ts` "payments and status"; `test/billing/receivables.test.ts` "property: balance = total − payments − write-offs ≥ 0…" and "the database refuses a payment beyond the balance, whoever writes it")
- [x] Reports: Invoiced, Payments received, and Receivables by age (current, 1–30, 31–60, 61–90, 90+ days overdue in the organisation's time zone), with CSV, for those who see rates (test). (`/invoices/reports?report=invoiced|payments|receivables` and `/invoices/reports/export`; `test/billing/receivables.test.ts` "buckets what is owed as current, 1–30, 31–60, 61–90 and 90+ days overdue on the organisation's day", Pacific/Auckland and London)
- [x] Optional late reminder per organisation: N days after due, then every M days, stopped by payment (test with a fake clock). (the hourly Cron Trigger and `scheduled` in `workers/app.ts`; `test/billing/schedule.test.ts`, called through the handler at a fixed `scheduledTime`: sent once, none for a paid invoice, nothing more on a second run)

### TS-062 · The calendar

Builder: an AI session on branch `ts-062-calendar`. It replaces the open parts of TS-039 (the month) and takes from TS-041 what a person's own calendar needs; the team's calendar and leave stay with TS-041 and TS-040. Asked for by the owner on 2026-11-11: "a week and … months where we can zoom in on the time", as Harvest's Timesheet has Day, Week and Calendar.

- [x] Timesheet has a third view, Calendar (`?view=calendar`), beside Day and Week; the address holds the scale (`scale=month`, the week by default), the day it is on (`date=`) and the week's zoom (`zoom=compact`, detailed by default), and an address it cannot read answers 400 (`test/timesheet/calendar.test.ts`, `test/pages/timesheet.test.ts`).
- [x] The week calendar shows the period's seven days from the organisation's week start on an hour axis, each entry a block from its start to its end, a running one growing live, each day's total at its column's head and the week's total; it opens scrolled to the working hours, an hour before the working day starts or at the earliest entry (`e2e/calendar.spec.ts`).
- [x] Zoom moves through month, week compact (the whole day fits, 24px an hour), week detailed (96px an hour: a 15-minute entry is a line of text) and the Day view, by one control or by `-` and `+`, and the zoom is kept in the address (browser test).
- [x] The month calendar shows the month's weeks from the organisation's week start, each day with its total and a bar of its share of the busiest day, today marked, the days outside the month muted, each week's total and the month's; a day opens the Day view and a week the week calendar (browser test). A week's total is the Week view's, the whole period, so a week that crosses the end of the month is counted whole in its row; the month's total counts its own days only.
- [x] Previous, Today and Next step by week or by month (browser test).
- [x] A block opens the entry's edit sheet (a running entry's, or one on a locked day, opens its Day view); an empty slot opens Track time with its start filled in, hours asked for, and the entry saved starts there (browser test; worker test of the action, a time the clocks skip refused).
- [x] Days the person may not change are marked "Submitted" and muted, and each day has a place for a status (`DayStatus`: a label, and whether the day is quiet and muted). Since TS-061 merged, it is filled from leave's `weekAway`: leave, a public holiday or "Not a working day", muted when nothing is expected that day (worker tests).
- [x] The calendar's day, week and month totals equal the Day and Week views' for the same days, for random sets of entries in London and Auckland and every week start (property test against `weekSheet` and `totalOf`); an entry belongs whole to the day it starts in, and one that crosses midnight is drawn in two parts, cut at midnight in the person's zone, on days of 23 and 25 hours too (property test that the parts cover each entry exactly).
- [x] Arrow keys move between days and along a day, Home and End to the ends, and Enter opens; each calendar is a table with one stop of Tab, its heads and cells labelled with the day, its total and its marks; nothing overflows the window at 390px (the week scrolls sideways inside its frame, opened at today); axe with WCAG 2.2 AA finds nothing at 390px and 1280px in both schemes (browser tests).
- [x] `docs/navigation.md` (the Timesheet row) describes the view.

Screenshots at 390px and 1280px in both schemes: `cmux-assets/browser/timesifier/TS-062/`. What is left is the owner's acceptance of them.

### TS-069 · B7 · Project budgets and alerts

Depends on: TS-064, TS-066, TS-067, TS-049.

The same branch and pull request as TS-066. A project's Settings tab sets the budget; Overview shows it.

- [x] A project has no budget, or a budget in total hours, hours per task, hours per person, total fees or fees per task, optionally resetting each calendar month in the organisation's time zone (`test/pages/money-rules.test.ts`, "a budget", one test per kind, and "a monthly budget": "starts again at the organisation's own midnight on the first of the month", in Auckland; `test/budgets/budget.test.ts`).
- [x] The project page shows spent, remaining and % for the budget's current period. Spent is the sum of entries (hours, or billable amount per TS-067) in that period (`test/pages/money-rules.test.ts`, "a budget's spent, for random entries (property)", over four zones, monthly and whole-project). A budget in fees is shown only to those who see rates ("a project's budget on its page"). A budget in hours is shown to those who see rates and to managers; a member is only warned.
- [x] The organisation chooses whether non-billable hours count against hour budgets (Workspace settings; `test/pages/money-rules.test.ts`, "non-billable counts against hour budgets until an owner or admin says not" and "of total hours counts every hour, the non-billable too unless the organisation says not").
- [ ] When spent first crosses the project's alert % (default 80) in a period, each manager of the project and each owner and admin gets one notification (TS-049) and at most one email. Crossing again in the same period sends nothing. The email is built and tested: once a period, to owners, admins and, for a budget in hours, the managers of those who tracked; a fees budget's to owners and admins (`test/pages/money-rules.test.ts`, "a budget's alert"). Not ticked (checked again by TS-092): the in-app notification is not built because Timesifier has no in-app notification surface yet (no notifications table, bell or inbox anywhere in `app/` or `migrations/`); the alert is sent by email only, and the in-app one comes with TS-049 (Notifications and reminders), in Backlog.
- [x] When "warn when over" is on, a person tracking to an over-budget project sees "This project is over budget" on the Track time sheet, and the entry still saves (`test/pages/money-rules.test.ts`, "the over-budget warning"; `e2e/money.spec.ts`, the keyboard test, which tracks to it after).

### Waiting on the owner's screenshots · the heading features and their Harvest parity

Merged and deployed on 2026-11-11: the Timesheet slice (TS-012a, TS-013, TS-012b, TS-046, TS-051, TS-052) in pull request #34, and TS-056 to TS-059 (`docs/harvest-comparison.md`, observed in Harvest's application with rea) in pull requests #38, #36 and #37, with the cards below. Each card's criteria and evidence stay on it; what is left for each is the owner's acceptance of its screenshots at 390px and 1280px in both schemes. Two departures from the Timesheet cards' texts, both from `docs/navigation.md`: the views are `?view=week` and `?view=history` on Timesheet's own address, not `/week`; the person's zone is set on My account, not Settings.

### TS-011a · Projects

Builder: an AI session on branch `ts-054-organize`, on TS-053's foundation, which made the table and the migration (`0006_heading_features`). In review: the pull request against `main`. Waiting on the owner for the screenshots.

**Routes:** `/app/:organisation/projects`, module `routes/app/projects.tsx`. Its loader lists the projects, active and archived. Its action takes the intents `create`, `rename`, `archive` and `restore`. The tab is kept in the address, `?show=archived`. `app/projects/projects.server.ts` holds `activeProjects` and `findActiveProject`, which the timer reads, and the writes.

**Who may** (the owner, 2026-11-11: every role manages projects)

| Action                                               | owner | admin | member |
| ---------------------------------------------------- | ----- | ----- | ------ |
| See the organisation's projects, active and archived | yes   | yes   | yes    |
| Create a project                                     | yes   | yes   | yes    |
| Rename a project                                     | yes   | yes   | yes    |
| Archive or restore a project                         | yes   | yes   | yes    |
| Delete a project                                     | no    | no    | no     |

- [x] A migration creates `projects`, and `projects` is in `tenantTables` (test: the scope of one organisation returns none of another's rows). _TS-053's `0006_heading_features`; `test/db/heading-tables.test.ts`._
- [x] `create` with a name of 1 to 120 characters after trimming stores one row and the list shows it. An empty name, a name of spaces and a name of 121 characters each answer 400 with the text "Enter a name of up to 120 characters." and store nothing. _`test/pages/projects.test.ts`, "create"._
- [x] A name is unique in its organisation ignoring case, archived projects included; the same name in another organisation is accepted. _`test/pages/projects.test.ts`, "refuses a name the organisation has in other letters, archived projects included", "accepts a name another organisation has"._
- [x] `rename` obeys both rules, and renaming "Design" to "DESIGN" is accepted. _`test/pages/projects.test.ts`, "rename"._
- [x] `archive` sets `archived_at`; the project leaves the default list and `activeProjects`, and appears under the tab "Archived". `restore` clears it. _`test/pages/projects.test.ts`, "archive and restore"; `e2e/organize.spec.ts`._
- [x] The action answers 400 to any other intent, and no request removes a `projects` row. _`test/pages/projects.test.ts`, "what the action takes"; `test/action-validation.test.ts`._
- [x] Every cell of the "Who may" table has a test through the real action, a manager's too. _`test/pages/projects.test.ts`, "who may"._
- [x] 404 for another organisation's page, and 404 with nothing changed for an action naming a project of another. _`test/pages/isolation.test.ts` (the route and its form); `test/pages/projects.test.ts`, "answers 404 to a project of another organisation"._
- [x] A new organisation has no projects. _`test/pages/projects.test.ts`, "a new organisation"._
- [x] With no projects the page shows "No projects yet", the sentence, and exactly one button, "Create project". _Same test._
- [x] A project can be created, renamed and archived with the keyboard alone. _`e2e/organize.spec.ts`, "a project is created, renamed and archived with the keyboard alone"._
- [x] axe with WCAG 2.2 AA reports no violations, empty and filled, at 390px and 1280px in both schemes. _`e2e/organize.spec.ts`, "Projects, empty and filled, its tabs and its sheets"._
- [ ] The pull request shows the page at 390px and 1280px in both schemes, and the owner has accepted the screenshots.

### TS-011b · Clients

Builder: an AI session on branch `ts-054-organize`. In review with TS-011a. Who sees Clients follows `docs/navigation.md`, which the owner approved after this card was written: owners and admins see and manage clients, and give a project its client; everybody else reads a project's client by its name on Projects and gets 404 at Clients. The organisation's switch (TS-048) hides Clients and every project's client from everyone.

- [x] A table `clients` (the columns of `projects`, with the same name rules) and a nullable `client_id` on `projects`. _TS-053's migration; `test/db/heading-tables.test.ts`._
- [x] Owners and admins can create, rename, archive and restore a client, see each client's projects, and give a project a client or none; a member and a manager get 404 for the page and every form, read a project's client on Projects, and cannot give one (403). _`test/pages/clients.test.ts`, "who may"; `test/pages/projects.test.ts`, "a project's client"._
- [x] Names are required, at most 120 characters, and unique within the organisation ignoring case, archived clients included. _`test/pages/clients.test.ts`, "names"._
- [x] An archived client is not offered when a project is created or edited, and its projects keep it, shown as "(archived client)". _`test/pages/projects.test.ts`, "an archived client is not offered, and the projects that have it keep it"; `test/pages/clients.test.ts`, "archiving a client keeps it on its projects"._
- [x] A client of another organisation is 404 to the actions and is never given to a project here. _`test/pages/clients.test.ts`; `test/pages/projects.test.ts`, "a client of another organisation is no client here"; `test/pages/isolation.test.ts`._
- [x] No accessibility violation, empty and filled, at 390px and 1280px in both schemes. _`e2e/organize.spec.ts`, "Clients and Workspace settings, with their sheets"._

### TS-048 · Workspace settings: general

Builder: an AI session on branch `ts-054-organize`. In review with TS-011a. General on Workspace settings holds the organisation's name (TS-009), its default time zone, the day its weeks start on, and the Clients switch; deletion stays below it.

- [ ] An admin or owner sets the organisation's default time zone and the day its week starts; members see the values and cannot change them (a test per role). _Not ticked. Met: owners and admins change both (`test/pages/settings.test.ts`, "the general settings"); a member and a manager get 404 for the page and every form, and nothing changes (same file). Left: Workspace settings is 404 to members (`docs/navigation.md`), so a member sees the values only through their effect: the week their Timesheet shows and their days' zone. Showing them on My account is the Timesheet slice's page._
- [ ] The week view and reports use the week start (test). _Not ticked. Met: the stored week start is the one `periodContaining` starts every period on, and the default zone is `zoneOfMember`'s for a person with none (`test/pages/settings.test.ts`). Left: the week view and reports are built on their own branches (TS-013, TS-014a), which read `membership.organisation.weekStartsOn`._
- [x] An admin or owner turns Clients off or on; off hides the Clients link and the client field everywhere and deletes nothing. _`test/pages/settings.test.ts`, "Clients off hides the link and 404s the page for everyone, and deletes nothing"; `test/pages/projects.test.ts`, "while Clients is off"; `test/pages/destinations.test.ts`; `e2e/organize.spec.ts`, "Clients turned off with the keyboard leaves the navigation, and its page is 404"._

### TS-038 · Teams and managers

Builder: an AI session on branch `ts-054-people`. Team > Teams (`/app/<slug>/team?show=teams`): an owner or admin creates, renames and deletes teams, adds and removes people, and makes a person a team's manager or ends it; a manager sees the teams they manage and changes nothing. `app/teams/teams.server.ts`; the route is `app/routes/app/team.tsx`. Who creates a team and names its manager, open for the owner, is built as proposed: an owner or admin, never the manager.

- [x] A team belongs to one organisation: the scope of one organisation returns none of another's teams (test). _`test/pages/team.test.ts`, "does not reach another organisation's team"; `test/pages/isolation.test.ts` posts to Team from another organisation and gets 404._
- [x] A member of an organisation is in none, one or several of its teams. Adding a person who is not a member of the organisation is refused (test). _`test/pages/team.test.ts`, "an owner adds people, marks a manager, and takes people out"._
- [ ] `manager` is a role a person holds for one team, between admin and member. The permission table in `docs/security.md`, "Roles", gains its rows, and a test covers every cell. _Not ticked. Met: the destinations table and `access.ts` rules (TS-053) with `test/organisations/access.test.ts`; the team-management rule in `docs/security.md`, and a manager's refusal for each change in `test/pages/team.test.ts`, "a manager sees the teams they manage and changes nothing". Left: the "Roles" table of the Better Auth endpoints has no manager column; a manager holds the role of a member there._
- [ ] A manager sees and exports the entries of the members of the teams they manage, and nobody else's (test with two teams). _Not ticked. Met for seeing: `test/pages/team.test.ts`, "shows a manager only the members of the teams they manage". Left: the export is the Reports slice's (TS-014b)._
- [x] A manager cannot change another person's entry (test). _`mayChangeTimeOf` in `test/organisations/access.test.ts`; a person's week on Team is read-only (`test/pages/team.test.ts`, "opens one person's week to read")._
- [x] Taking a person out of a team, or ending their time as its manager, takes effect on their next request (test). _`test/pages/team.test.ts`, "an owner adds people, marks a manager, and takes people out": the next request is 404._

### TS-045 · Team: this week, members and invitations

Builder: an AI session on branch `ts-054-people`. `app/routes/app/team.tsx` with `app/teams/week.server.ts`; Members and Invitations carry the tabs (`app/teams/TeamTabs.tsx`).

- [ ] Team > This week lists, for one week with arrows to earlier ones, each person the viewer may see: hours logged against their expected hours from TS-061 (which replaced TS-042), whether a timer is running, and the period's submission status (test). _Not ticked. Met: hours, running timer, status, arrows (`test/pages/team.test.ts`, "shows each visible person's hours, running timer and status"; `e2e/people.spec.ts`). Left: expected hours come with TS-061, in review._
- [x] A manager sees the members of the teams they manage, an admin or owner everyone; a member sees no Team link and gets 404 at its address (a test per role). _`test/pages/team.test.ts`, "shows a manager only…", "is not there for a member"; `test/pages/destinations.test.ts`._
- [x] Opening a person shows their Week view, read-only; nothing on it can change their entries (test). _`test/pages/team.test.ts`, "opens one person's week to read, and nobody else's"; `e2e/people.spec.ts`._
- [x] Members and Invitations move from Settings to tabs of Team, with the same rules and tests as TS-009; the old addresses redirect (test). _`test/pages/team.test.ts`, "links the tabs"; `test/pages/members.test.ts`; `e2e/organisations-keyboard.spec.ts`; the redirect is TS-053's (`test/pages/isolation.test.ts`)._

### TS-047 · Approvals

Builder: an AI session on branch `ts-054-people`. `app/routes/app/approvals.tsx` with `app/approvals/approvals.server.ts`; the count is on the link through the organisation's loader and `Navigation`'s `counts`. A decision goes through `statusAfter` and writes the period and its `period_events` row in one batch.

- [x] A manager sees submitted periods of their team's members; an admin or owner sees everyone's; a member sees no Approvals link and gets 404 at its address (a test per role). _`test/pages/approvals.test.ts`, "sees and decides only their teams' people", "is not there for a member"; `test/pages/destinations.test.ts`._
- [x] Approvals shows one period at a time with Previous and Next, in tabs Pending, Not submitted and Decided; the link shows the number pending (test). _`test/pages/approvals.test.ts`, "shows a period's pending, not submitted and decided people", "puts the pending count on the Approvals link"; `e2e/people.spec.ts`._
- [x] Approve one, or all pending on the page, or return with a comment of at most 500 characters; each decision is recorded with who and when (tests). _`test/pages/approvals.test.ts`, "approve writes the status and an event in one go", "approve all…", "return needs a comment"._
- [x] A manager's own period is decided by an admin or owner, never by the manager (test). _`test/pages/approvals.test.ts`, "whose own team manages them too still cannot decide their own"._
- [x] An owner or admin reopens an approved period with a reason, which returns it to the person (test). _`test/pages/approvals.test.ts`, "an owner or admin reopens…; a manager cannot"._
- [x] Not submitted lists the people who have not submitted a closed period (test). _`test/pages/approvals.test.ts`, first test._
- Decided by the owner on 2026-11-11: approval is always on for now. Whether an owner or admin can turn it off for the organisation, as Harvest allows, waits for a customer who asks. The evidence is in `docs/navigation.md`, "Gaps the flows show".

### TS-014a · Reports

Builder: an AI session on branch `ts-054-reports`, one of the four slices built on TS-053. In review: the pull request against `main`. This is where "administrators can look at their time" (the owner, 2026-11-11) is built, and the manager's reach that TS-038 names is the foundation's `timeScopeOf`. The brief for the heading features (2026-11-11) had the days counted in the organisation's time zone and an entry that crosses midnight cut there and counted on each day. TS-091 reversed both after the production audit (W04, W33), because Reports then disagreed with the Timesheet about the same entry: a report now follows decision 26 like every other page, its days in the viewer's zone, each entry whole on the day it starts. What the brief added and stays: a running entry is counted up to the time of the request instead of being left out (decision 26, "Reports and exports"). The date range needed no decision 28: its two days are the browser's own date fields, which write no `style` attribute.

- [x] A report covers a chosen range of days, this week, last week, this month or a custom range of up to 366 days, in the viewer's time zone, grouped by project, client or day, with its total. The range, the grouping and the person travel in the address, and each applies as it changes. A custom range that is backwards, longer than 366 days or not a date shows the page again with the days as typed and the reason under the field (`test/reports/report.test.ts`, "the report an address asks for" and "the days of a range"; `test/pages/reports.test.ts`, "shows the page again for a custom range" and "counts its days in the viewer's zone"; `e2e/reports.spec.ts`, chosen and shown with the keyboard alone, and "a custom range that runs backwards").
- [x] A report holds the entries that start in its range, each counted whole on the local day it starts, never cut at midnight (decision 26); a running entry is counted up to now (`test/reports/report.test.ts`, "an entry in a report"; `test/pages/reports.test.ts`, "counts an entry of 21:33 to 02:33 whole on the day it starts", "counts its days in the viewer's zone" and "counts a running entry up to now").
- [x] Every figure is whole minutes, and every total as written equals the sum of the rows as written, in every grouping and in Entries (property test over 60 seeded sets of entries in six zones, clock changes included: `test/reports/report.test.ts`, "a property of every report (W07)").
- [x] A member sees their own entries, a manager their own and their teams' people's, an owner or admin everyone's, and each may narrow the report to one person they may see. Naming anybody else is the 404 of another organisation (`test/pages/reports.test.ts`, "whose time a report holds", a test for each role).
- [x] The report contains only the caller's organisation ("holds nothing of another organisation"), and its two routes are in the cross-organisation 404 test (`test/pages/isolation.test.ts`).
- [x] The page works from the keyboard and has no WCAG 2.2 A or AA violation at 390 and 1280 px in either scheme, with entries and with none (`e2e/reports.spec.ts`).

### TS-014b · CSV export

Builder: the same session and branch as TS-014a. In review with it.

- [x] The export, at `reports/export` with the report's own query, has one row for each entry that starts in the range, an entry across midnight included: the rows the page lists, each its whole minutes, so its durations add up to the page's total. Its columns, in this order: `entry_id`, `person`, `project`, `client`, `description`, `started_at`, `ended_at`, `duration_seconds`. Times are in UTC, in ISO 8601 with `Z`; a running entry has no end (`test/reports/report.test.ts`, "a row of the CSV"; `test/pages/reports.test.ts`, "counts an entry of 21:33 to 02:33 whole on the day it starts" and "counts a running entry up to now"; `e2e/reports.spec.ts`, the download).
- [x] The file parses back to the same values with an RFC 4180 parser (property test over 100 seeded files of descriptions with commas, quotes, line breaks and characters outside ASCII: "a property of every export").
- [x] A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` (`test/reports/report.test.ts`, "a cell of the CSV"; `test/pages/reports.test.ts`, "cannot start a spreadsheet formula").
- [x] The response is streamed in pages of 200 entries keyed on `id`, and nothing is stored (`test/pages/reports.test.ts`, "holds every entry, page after page", with 451 entries).
- [x] A member exports their own entries, a manager their teams', an owner or admin every member's, and the export contains only the caller's organisation (`test/pages/reports.test.ts`).
- [x] The file is UTF-8 with a byte order mark, so Excel reads it as UTF-8, sent as `text/csv; charset=utf-8` and named `timesifier-<slug>-<first day>-to-<last day>.csv` (`test/pages/reports.test.ts`, "is a UTF-8 CSV attachment"; `e2e/reports.spec.ts`).

### TS-030 · A home page, a privacy page, a terms page, and the visual direction

Built by an AI session on branch `ts-030-landing`; not yet deployed. The owner's verdict on what was first deployed: it works, but it does not look like a designed product. This card writes the direction the product follows in `docs/design-direction.md`, changes the tokens to carry it, and replaces the three-line home page. It also takes the home-page criterion that TS-025 held. Because sign-up stays open to the public (the owner, 2026-11-11), the privacy page and the terms page ship with it. It is in Review because three criteria wait for the owner, two wait for a later card, and one waits for the deploy; what is left is said on each open criterion.

- [ ] The direction is written down before anything is built: who the product is for, the feeling, the typefaces, the palette, how imagery is used, three things the design refuses to do, and the shipped products it was checked against. It is in `docs/design-direction.md`, and an entry in `docs/decisions.md` replaces entries 4 and 16 with what stays, what goes and what is undecided. It is entry 24: entry 23 is the removal of passkeys. _Not ticked. Met: `docs/design-direction.md` holds every part named, and entry 24 in `docs/decisions.md` replaces entry 16. Left: entry 24 leaves entry 4 standing ("It changes values, not the system") and does not list what is undecided._
- [ ] The owner has approved the direction. TS-011a waits for this.
- [x] The tokens carry the direction and still come from one seed. Every text role is at least 4.5:1 on its background in both schemes (test). _`scripts/tokens.test.ts`, "colour roles". The seed is the mark's amber, `#FEAD05`, in the fidelity scheme; the ink is its charcoal, `#252A2F`._
- [x] `/` says what Timesifier does for a person, offers one primary action, "Get started", with "Sign in" beside it, both opening `/sign-in`, and shows the product before any scrolling at 390px and 1280px (browser test). _The words changed from "Create an account" on the owner's instruction of 2026-11-11, quoted on TS-036. `e2e/landing.spec.ts`, at 390px and 1280px in both schemes: "the primary action and the product are on show before any scrolling, and nothing runs off the side"; "there is one way in: the primary action at the top and at the end, and Sign in, lead to the same page". `test/claims.test.ts`: "the home page has one primary action, said the same at the top and at the end, and one way in"._
- [x] The page shows nothing the product will not do, and every total on it is the sum of what is shown above it (test). _`test/running-day.test.ts` holds the arithmetic at every time of day; `test/day-anatomy.test.ts`. `e2e/landing.spec.ts`: "the timer gains a second each second, and the day's total stays the entries shown added to it"; "every drawing that shows a time carries the word that says it is an example". `test/claims.test.ts` ties the checkable claims to their facts._
- [x] The page is server rendered and works without script (browser test). _`e2e/landing.spec.ts`, "without script": "the page is all there, and its primary action still opens the sign-in page"._
- [x] No accessibility violation at 390px and 1280px in the light and the dark scheme; the keyboard reaches the primary action, which shows its focus (browser test). _`e2e/landing.spec.ts`: "the home page has no accessibility violations" (four cases, and the drawing's own text measured at 4.5:1 or more); "the keyboard reaches the primary action, which shows where the focus is and opens the sign-in page"; "the skip link moves the focus into the main region". Each also runs in WebKit._
- [x] Every photograph is our own file with its size, a description and its source on record, and nothing moves when one arrives (tests). _Three photographs under the Unsplash licence in `public/images/` with `CREDITS.md`. `test/node/landing-images.test.ts`; `e2e/landing.spec.ts`: "every image has its size, a description, and comes from our own host"._
- [x] The components still pass their own tests on the new tokens. _`e2e/components.spec.ts`, `e2e/design.spec.ts` and `e2e/accessibility.spec.ts` pass in Chromium and WebKit on the new tokens._
- [ ] `/privacy` and `/terms` exist and are server rendered. The privacy page says what is stored about a person, why, that it rests in the EU, for how long, and how to have an account deleted before TS-021a is built. A test finds a link to each on `/`, `/sign-in` and `/sign-up`. _Not ticked. Met: both pages exist, are server rendered and are linked from `/` (`test/documents.test.ts`: "is answered whole by the server, with the date of its version and the address to write to", "the home page links to both"; `e2e/documents.spec.ts`; `test/claims.test.ts` for the EU sentence). Left: no test finds the two links on `/sign-in` and `/sign-up`; those pages are TS-036's._
- [ ] From TS-006: in the rail the travelling indicator no longer passes over the labels between two destinations; the skip link, while focused, no longer covers the top of the rail; the radio rings in Settings line up with the headings above them. Each has a browser test or a screenshot the owner has accepted. _Not done on this branch: it changes nothing in `app/shell/`. TS-037 restyles the shell._
- [ ] Deployed after TS-043, and seen by the owner at `https://timesifier.com`.

Added while the card was built, each with its evidence:

- [x] The owner's mark is the product's identity: traced to paths, beside the name at the top and the foot of every public page, as the icon of every page, and on the picture a shared link is shown with. _`app/components/mark-paths.ts` differs from the owner's drawing on 0.056% of its pixels. `e2e/identity.spec.ts`: "the name is read once at the top, with the mark beside it as decoration"; "every page names its icons, and each is a file of the right kind on our own host"; "the picture for a shared link is ours, 1200 by 630, and named in full"; "the browser's own frame takes the colour of the band, in each scheme". `docs/design-direction.md`, "The mark"._
- [x] The example on the page keeps time: the timer runs on the visitor's own clock from a believable start, the date is their today, the control stops and starts it, and every total stays the sum of what is shown. Without script it is a still example that adds up. _`e2e/landing.spec.ts`, "the clock": "the timer gains a second each second, and the day's total stays the entries shown added to it"; "the control stops the timer where it is, and starts it again from there"; "the sheet is the visitor's own today, and its timer started a believable while ago"; "without script": "the day is a still example that adds up, with nothing to press". `test/running-day.test.ts` holds the arithmetic at every time of day._
- [x] What moves is tied to the scrolling, animates only `transform` and `opacity`, moves nothing beside it, and stands still with reduced motion; a running time is never read out as it changes. _`e2e/landing.spec.ts`: "script takes the page over without moving anything on it"; "nothing on the page moves when its images arrive"; "the clock still tells the time, and nothing slides, grows or drifts"; "the control is worked from the keyboard, and nothing reads the time out as it changes". No test raises a Content Security Policy violation (`e2e/fixtures.ts`)._
- [x] One anatomy figure explains how a working day of focused stretches and breaks becomes a number to bill from, every length in it computed from the example; anatomy figures are a pattern of the design system. _`test/day-anatomy.test.ts`. `e2e/landing.spec.ts`: "the anatomy of a working day has a name, and says in words what it draws"; "reads the same clock as the timer"; "is put together as it is scrolled into the window"; "is whole wherever the page stands". `docs/design-direction.md`, "Anatomy figures". The system diagram in `docs/architecture.md` is drawn the same way by `scripts/architecture-figure.ts`._
- [x] The page counts in every scale of time: seconds on the timer, minutes and hours on the day, days in the week, and the week in its month and year. _`app/landing/YearStrip.tsx`; `test/running-day.test.ts`: "a week belongs to the year its Thursday is in"._
- [x] Every link on the three public pages leads to a page or a place that exists and says something. _`e2e/public-links.spec.ts`: "every link on / leads to a page or a place that exists", and the same for `/privacy` and `/terms`._
- [x] Nothing on the public pages is untrue. All 93 claims were audited on 11 November 2026; the 39 that were not plainly true were reworded to what is true or removed, and the checkable ones are tied to their facts. _`test/claims.test.ts`: "the privacy notice lists every cookie the application sets, and counts them"; "the pages say the database is in the EU because that is how the databases are created"; "wherever a page says the database is in the EU, it says what is not"; "the home page has one primary action, said the same at the top and at the end, and one way in". `e2e/landing.spec.ts`: "every drawing that shows a time carries the word that says it is an example". `docs/design-direction.md`, "Nothing on the page is untrue"._
- [x] What the landing page shares with the product is in `app/components/`, in the gallery, with tests: the lockup, a sheet of rows, a changing time, the timer's mark. _`e2e/components.spec.ts`: "Digits is read as one time, is not announced as it changes, and redraws only the digit that changed"; "Ledger is a list of rows under a heading: a row is read as its title, its detail and its figure"._
- [x] `docs/design-direction.md` gives the convention for the signed-in screens, concrete enough to restyle the shell and the existing pages, and the mindset as rules for every screen. _"For the product screens", "The mindset, on every screen". Guidance only: no signed-in screen is changed on this card._
- [x] The privacy notice names who runs Timesifier. _The owner supplied it on 2026-11-14: `docs/decisions.md`, entry 46. Built on TS-121, from the deployment's settings; ticked when TS-121's tests have run (`test/documents.test.ts`, "the privacy notice says which company answers for what is stored")._
- [ ] `privacy@timesifier.com`, the address both notices give, receives mail and is read.

### TS-061 · Leave and working week

Builder: an AI session on branch `ts-061-leave`, migration `0007_leave`. In review: the pull request against `main`. It replaces TS-040 (Leave) and TS-042 (Policies), which are gone from Backlog: the owner settled their open questions on 2026-11-11, as below, and a person who is not working is now shown wherever time is, which neither card asked for. Code in `app/leave/`, the destination `app/routes/app/time-off.tsx`; `docs/navigation.md`, flow 7, `docs/security.md`, "Whose time", and `docs/architecture.md`, "Tables", describe it.

The owner's decisions (2026-11-11):

- Six kinds of leave in each organisation: Annual, Sick, Study, Parental, Unpaid leave and Public holiday. An owner or admin renames a kind or switches it off. Public holidays are days the organisation lists, and apply to everyone in it.
- Leave is taken in whole days, with a half day at either end.
- Sick leave and public holidays need no approval: a request is approved as it is made. Any other kind waits for a manager of a team the person is in, or an owner or admin. Nobody decides their own. A decided request is not decided again. A pending request can be withdrawn by its person. Approved leave that has not begun can be cancelled by an owner or admin, with a reason, never on their own leave.
- Each kind has an allowance a year: Annual leave 25 days, the others none, which is no limit. The leave year is the calendar year, and nothing is carried over. What is left is the allowance less the approved and the pending days of that year; a request for more is refused.
- Everyone may be told that a colleague is on leave, never the kind. The person, the managers of their teams, owners and admins see the kind.
- Each organisation has one working week, days and hours: Monday to Friday, 7.5 hours a day, to start with.

- [ ] Every organisation, new or existing, has the six kinds and the working week of Monday to Friday at 7.5 hours; a new one gets them from the trigger `organisations_leave_defaults` however its row is made (test).
- [ ] The four tables are in `tenantTables`; the database refuses a request of another organisation's kind or for a person who is not a member, and a request goes with its person's membership (test).
- [ ] Time off is under Track, after Timesheet, for every role; a member sees four main links, a manager six, an owner or admin eight, and the eight fit the bar at 390px with the number on Approvals (tests, browser test).
- [ ] A person asks for a kind that is on, from a first to a last day, with a half day at either end; a kind switched off, the public holidays, a last day before the first, days that hold no working day, days already asked for, and more than is left of the allowance are each refused (tests).
- [ ] Sick leave is approved as it is made; a kind that needs approval waits, and its days come off what is left at once (tests).
- [ ] A pending request is withdrawn by its person and by nobody else (test).
- [ ] A request is approved or refused, with an optional comment, by a manager of a team the person is in, an owner or an admin, from Time off's Requests tab or Approvals' "Time off waiting"; never by the person, whatever their role, nor by a manager of none of their teams; a decided request answers 409 and does not change (a test for every role).
- [ ] An owner or admin cancels approved leave that has not begun, with a reason; never their own, never leave that has begun or is not approved (tests).
- [ ] The number on the Approvals link counts the periods and the requests for leave waiting for the person (test).
- [ ] An owner or admin sets the working week (hours as `7.5` or `7:30`, empty for a day not worked), renames a kind, switches it off, sets whether it needs approval and its allowance in whole or half days, and adds and removes public holidays; a manager or member is not shown Workspace settings and gets 404 there, and a kind or holiday of another organisation is 404 (a test for every role). My account shows the working week to everyone.
- [ ] Where a person stands is worked out on each request from the data, never stored: Working while their timer runs, else On leave (or on leave for half the day), Not working today on a public holiday or a day not worked, or Available (test). Whoever may not see the kind is shown "On leave" (test).
- [ ] Timesheet names each day of leave, public holiday and day not worked in the week's days and on the day, with the time expected; a whole day of leave or a public holiday says so on the Day view and still takes time; the Week view has an Expected row (tests).
- [ ] Team > This week shows each person's hours of the hours expected of them, their days of leave, and on the current week where they stand now; a person's week marks the same days (test, browser test).
- [ ] Approvals' Not submitted leaves out a person whose whole period is leave, public holidays and days not worked (test).
- [ ] Reports has a People section: each person's time worked beside the time expected of them and their leave; leave is never in a total of worked time (test).
- [ ] Every new route and form joins the cross-organisation 404 test of TS-009 (`test/pages/isolation.test.ts`).
- [ ] Keyboard alone and axe with WCAG 2.2 AA on Time off, its sheet, and leave on Timesheet, Team and My account, at 390px and 1280px in both schemes (browser test).
- [ ] typecheck, lint, the tests and the browser tests pass in the pipeline; the pull request shows Time off and the Requests tab at 390px and 1280px, and the owner has accepted them.

What follows from the decisions, and is not a defect: a change to the working week, a holiday or an allowance changes what is worked out for every day, past days included, because nothing of it is stored; no request changes its status. A request from a person nobody else may decide for (the organisation's only owner, with no other owner or admin and no manager of a team they are in) is approved as it is made, recorded as decided by them with the comment "Approved automatically: nobody else can decide it", and the request sheet tells them so before they send it (decision of 2026-11-11).

Not in this card: leave accrued month by month, carry-over, hours of leave rather than half days, a working week or holiday calendar per person or team, and the team calendar (TS-041).

## Ready (limit 3)

The next cards, in the order they are pulled. A card is pulled only when every card on its "Depends on" line is Done. Ready holds four cards until TS-036 is pulled: the owner added it on 2026-11-11, ahead of the three that were here.

### TS-036 · One way in

The owner, 2026-11-11: "We don't really need create accounts per se. We just need a word like get started or something like start tracking. When you click that, that's automatically taking us to a login page. That login page shouldn't be sloppy either. Every link we have at the bottom of the page should not be dead links."

**Depends on:** TS-029 (Done) and TS-030. The branch is cut from `main` after TS-030 merges.

**Reference for the screen:** `docs/design-direction.md` and the home page, both from TS-030. The page uses the home page's header without its section links and its footer without "Sign in".

**Owns:** `app/routes/sign-in.tsx`, `app/routes/auth/`, the words of the home, privacy and terms pages, the answer to `/sign-up` under `workers/`, the keys `app/auth/sign-in-code.server.ts` accepts, the "Signed in as" line on `/app/new` and on the invitation page, and the browser tests of signing in with `e2e/auth.ts`.

**Interfaces:** every later card signs a person in through the one page. The helper in `e2e/auth.ts` that makes a person does so, and sets a name in Settings where a test needs one.

**Routes**

- `/sign-in`, module `routes/sign-in.tsx`: one page with two views, the email address and then the eight-digit code, for new and returning people alike. It never says whether an address has an account.
- `GET /sign-up` is no longer a page. The Worker answers it before the framework with status 302 and a `Location` built by the existing rule for `next` (`safeNext`), with every other query dropped. `sign-up` leaves the route configuration and stays among the reserved organisation slugs.
- `POST /api/auth/sign-in/email-otp` stops taking a `name`. No name is asked on the way in: a person sets one in Settings, as today.

**Tables:** none. The address and the time of a request for a code are kept in the tab's `sessionStorage` for the code's five minutes, and nothing else is stored in the browser.

**Who may:** anyone, signed out. There is no role before a session.

**The words**

| Where                                                           | Words                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Home page, primary action (hero and closing band)               | Start tracking                                                                        |
| Home page, quiet link beside the primary action, at every width | Sign in                                                                               |
| Page title                                                      | Sign in · Timesifier                                                                  |
| Heading, first view                                             | Enter your email                                                                      |
| Lead, first view                                                | We will email you a code. If you are new here, the same code sets you up.             |
| Button, both views                                              | Continue                                                                              |
| Second view                                                     | As now, plus the sentence "We send at most five codes an hour to one address."        |
| When Turnstile's check fails                                    | We could not confirm this browser. Wait a moment and press Continue again.            |
| `/app/new` and the invitation page's "no longer valid" state    | "Signed in as" with the address, and a quiet "Use a different email", which signs out |

**Acceptance criteria**

- [ ] A new address goes from `/` by "Start tracking" to the email address, the code, "Create your organisation" and Today (browser test at 390px and 1280px).
- [ ] A returning address with an organisation goes from `/` by "Sign in" to the email address, the code and Today (browser test).
- [ ] An invited new address, signed out, goes from the invitation link to the email address, the code, the invitation's page, Join and the organisation (browser test).
- [ ] A person who asks for a code, reloads the page and types the code is signed in, without asking again (browser test at 390px).
- [ ] `GET /sign-up?next=/invitations/abc` answers 302 with `Location: /sign-in?next=%2Finvitations%2Fabc`, and `sign-up` appears under `app/` only in the reserved slugs (test).
- [ ] `POST /api/auth/sign-in/email-otp` with a `name` is answered 400 (test).
- [ ] No server-rendered page and no email contains "create an account", "create account" or "sign up" (a test over every server-rendered page).
- [ ] Every `a[href]` on `/`, `/privacy`, `/terms` and `/sign-in` leads to a page that answers 200 or to an element on the page; `mailto:` links and other origins are listed in the test (test).
- [ ] Moving between the home page and `/sign-in` is a whole page load in both directions; a test fails if a link or a redirect reaches `/sign-in` without one.
- [ ] `/app/new` and the invitation page's "no longer valid" state each show "Signed in as" with the address, and "Use a different email" signs out and returns to `/sign-in` keeping `next` (browser test).
- [ ] The existing accessibility, keyboard and reduced-motion tests of the sign-in pages pass, moved to the one page and extended only to what this card changes.
- [ ] `docs/security.md`, `docs/architecture.md` and `README.md` describe one page, and the criteria of TS-008 and TS-025 that this card supersedes are marked as such.
- [ ] The pull request shows the two views of `/sign-in`, each beside the home page, at 390px and 1280px in the light scheme and at 1280px in the dark, and the three refusals (too many attempts, a wrong code, the check failed). The owner has accepted them.

Not in this card: the signed-in shell and pages (TS-037), the sign-in and invitation emails, and any change to the server beyond the two above.

What holds for the three cards below, from `app/db/schema.ts`: an id is a UUID version 7 stored as text; a time is an integer of milliseconds since the Unix epoch, in UTC; a table with an `organisation_id` is added to `tenantTables` and reached only through `organisationScope`. The organisation's slug is the route parameter `organisation`, so the addresses below are written `/app/:organisation/…`. The integrator gives each card its migration number before work starts.

### TS-012a · Timer

**Depends on:** TS-011a; TS-022a. Decisions 25 and 26 are written.

**Reference for the screen:** `docs/design-direction.md`, and the timer shown on the home page of TS-030.

**Owns:** `app/routes/app/today.tsx`, a new folder `app/time/`, one migration, `time_entries` and `users.time_zone` in `app/db/schema.ts`, the `batch` method in `app/db/scope.ts`, and the tests of the timer.

**Interfaces:** reads the active projects through TS-011a's function. TS-013 reads `time_entries` and `users.time_zone` and builds on the same route module.

**Routes**

- `/app/:organisation`, module `routes/app/today.tsx`, the existing Today destination. Its action takes the intents `start` and `stop`.
- `/app/:organisation/settings`, module `routes/app/settings.tsx`. Its action gains the intent `time-zone`.

As built by TS-009, a new person creates an organisation at `/app/new`, then a project (TS-011a), then starts a timer. This card adds no step and removes none (the owner, 2026-11-11). No new address.

**Tables**

`users` gains `time_zone`: text, null until set. It holds an IANA name such as `Europe/London`, accepted only if it is `UTC` or `Intl.supportedValuesOf("timeZone")` holds it. While it is null, times are shown in UTC.

`time_entries`

| Column                     | Type and constraint                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `id`                       | text, primary key                                                                      |
| `organisation_id`          | text, not null, references `organisations.id`, cascade on delete                       |
| `user_id`                  | text, not null, references `users.id`, no cascade (decision 25)                        |
| `project_id`               | text, not null, references `projects.id`                                               |
| `description`              | text, null, at most 500 characters                                                     |
| `started_at`               | integer, not null                                                                      |
| `ended_at`                 | integer, null while the timer runs; check `ended_at IS NULL OR ended_at >= started_at` |
| `created_at`, `updated_at` | integer, not null                                                                      |

Indexes: unique on `(organisation_id, user_id) WHERE ended_at IS NULL`; `(organisation_id, user_id, started_at)`; `(organisation_id, project_id, started_at)`.

`organisationScope` gains `batch`: several scoped statements sent as one D1 batch, all applied or none.

**Who may**

| Action                                    | owner | admin | member |
| ----------------------------------------- | ----- | ----- | ------ |
| Start a timer for themselves              | yes   | yes   | yes    |
| Stop their own running timer              | yes   | yes   | yes    |
| See their own running timer               | yes   | yes   | yes    |
| Start, stop or see another person's timer | no    | no    | no     |
| Set their own time zone                   | yes   | yes   | yes    |

**Acceptance criteria**

- [ ] A migration adds `users.time_zone` and creates `time_entries` with the columns, the check and the three indexes above; `time_entries` is in `tenantTables` (test).
- [ ] A person whose `time_zone` is null has it set from the zone their browser reports the first time they open a page under `/app`. For a new account that is the page that follows the code: nothing is asked on the way in (TS-036). A name that is neither `UTC` nor known to `Intl` is not stored (test).
- [ ] Settings shows the person's zone and lets them choose another. The intent `time-zone` with a known name stores it; an unknown name answers 400 and stores nothing (test).
- [ ] `start` stores one row with `started_at` equal to the server's clock, whatever time the request claims, and `ended_at` null (test with a fixed clock).
- [ ] `start` names an active project of this organisation. No project, an archived project, or a project of another organisation answers 400 and stores nothing (test).
- [ ] A description of 500 characters is stored; one of 501 answers 400 and stores nothing (test).
- [ ] `stop` sets `ended_at` to the server's clock on the caller's running entry. With nothing running it changes nothing and answers the page as it is (test).
- [ ] A second running row for the same person and organisation is refused by the index when inserted directly (test).
- [ ] `start` while a timer runs stops the first and starts the second in one `batch`, and the first entry's `ended_at` equals the second's `started_at`. When the insert is made to fail, the first entry is still running (test).
- [ ] A person in two organisations can run one timer in each at the same time (test; decision 25).
- [ ] Elapsed time is worked out from the stored `started_at`. Two browsers signed in as the same person show the same elapsed value, to the second, after each loads the page (browser test with a controlled clock).
- [ ] The page reads its state again when the window gains focus and every 30 seconds. A stop made in one browser shows in the other within 30 seconds. There is no live push and no new platform part (browser test).
- [ ] The start time is shown in the person's zone. For `Europe/London`, an entry started at 2026-03-29T00:30Z shows 00:30 and one started at 01:30Z shows 02:30. An entry running across that clock change shows an elapsed time equal to end minus start in real seconds (test).
- [ ] With no active project, Today shows a heading "No project to track yet" and exactly one link, named "Create a project", which opens Projects. With at least one, it shows the active projects to choose from and one button named "Start timer" (test).
- [ ] `stop` takes no entry id. An action sent to an organisation the caller is not in answers 404 and changes nothing, and both intents are tested beside `test/pages/isolation.test.ts` (test).
- [ ] While the timer runs the seconds change once a second and the changed digit moves. With reduced motion requested, `getAnimations()` on the timer is empty (browser test, as `e2e/shell-transitions.spec.ts`).
- [ ] The timer can be started and stopped with the keyboard alone, has an accessible name, and is not announced every second. axe with WCAG 2.2 AA tags reports no violations (browser test).
- [ ] No log line holds a description: a failed statement during `start` logs the error's name and the path alone (test, as `test/error-log.test.ts`).
- [ ] The pull request shows the page with no project, with a timer stopped and with one running, at 390px and 1280px in both schemes, and the owner has accepted the screenshots.

Not in this card: adding, editing and deleting entries by hand (TS-012b).

### TS-013 · Today and week views

**Depends on:** TS-012a. Decision 26 is written.

**Reference for the screen:** `docs/design-direction.md`, and the day sheet and the week shown on the home page of TS-030.

**Owns:** the list and the totals in `app/routes/app/today.tsx`, a new module `app/routes/app/week.tsx` and its line in `app/routes.ts`, the day and week arithmetic in `app/time/`, and the tests of both pages.

**Interfaces:** none new. TS-014a reuses the day arithmetic.

**Routes**

- `/app/:organisation`, module `routes/app/today.tsx`: one day. `?day=YYYY-MM-DD` chooses it; without it, today in the person's zone.
- `/app/:organisation/week`, a new module `routes/app/week.tsx`, a page inside the Today destination: Monday to Sunday. `?start=YYYY-MM-DD` chooses the Monday; without it, the current week in the person's zone.

**Tables:** none new. The pages read `time_entries`, `projects` and `users.time_zone`. The Worker works out the bounds of the day or the week in the person's zone and passes them to SQL as UTC integers.

**Who may**

| Action                                                | owner | admin | member |
| ----------------------------------------------------- | ----- | ----- | ------ |
| See their own entries and totals for a day or a week  | yes   | yes   | yes    |
| See another person's entries or totals on these pages | no    | no    | no     |

**Acceptance criteria**

- [ ] Today lists the caller's entries whose start falls in the chosen local day, earliest first, each with its project's name, its description, start, end and duration, and one total for the day (test).
- [ ] Week shows seven days from Monday, a total for each day, a total for each project (an archived project by its name) and one total for the week (test).
- [ ] For random sets of entries, each day's total equals the sum of the durations listed for that day, and the week's total equals both the sum of its day totals and the sum of its project totals (property test).
- [ ] A running entry is listed as "Running" and counted from its start to the time of the request (test with a fixed clock).
- [ ] An entry belongs whole to the local day it starts in. For `Europe/London`, an entry from 23:30 to 00:30 is listed and counted under the first day only (test).
- [ ] The same entry falls in different days for a person in `Pacific/Auckland` and a person in `Europe/London`. In the week of 2026-03-29 in London, an entry started at 00:30 local on the Sunday is in Sunday's column, and the week's bounds are right although that day has 23 hours (test).
- [ ] A `day` or `start` value that is not a date, or a `start` that is not a Monday, answers 400 (test).
- [ ] Links named "Previous day", "Next day", "Previous week", "Next week" and "Today" change the address and are reachable by keyboard. Going later moves forward and going earlier moves back. With reduced motion requested nothing moves (browser test, as `e2e/shell-transitions.spec.ts`).
- [ ] The navigation marks Today as the current destination on `/app/:organisation/week` (test of `destinationIndex`, and browser test).
- [ ] With two members in one organisation, neither page shows the other's entries or counts them in a total (test).
- [ ] A member of organisation A receives 404 for both pages of organisation B, and `test/pages/isolation.test.ts` lists `/app/:organisation/week` among the routes it walks (test).
- [ ] The query behind each page uses the index `(organisation_id, user_id, started_at)`: `EXPLAIN QUERY PLAN` names it (test).
- [ ] With no entries in the day, the list shows the sentence "Nothing tracked on this day." and adds no button: the timer's is the page's one primary action (test).
- [ ] One browser test starts from an address never seen before and does only this: enters the address on `/sign-in`, enters the code, names an organisation, creates one project, presses "Start timer" and opens Week. It finds the running entry in today's column. The test has a time limit of 120 seconds for all of it, so it fails when the steps take longer. This is the criterion for "under two minutes" in `docs/product.md`.
- [ ] axe with WCAG 2.2 AA tags reports no violations on either page, empty and filled, in both schemes (browser test).
- [ ] The pull request shows both pages at 390px and 1280px in both schemes, and the owner has accepted the screenshots.

Moved out of this card: "an entry can be added from the keyboard alone" is on TS-012b, where entries are added by hand.

## Backlog

In priority order. Before a feature card enters Ready it gains "Routes", "Tables" and "Who may" sections like the three cards above, and the criterion that every new route joins the cross-organisation 404 test of TS-009.

The navigation these cards build towards, by role, is in `docs/navigation.md` (adopted 2026-11-11, rearranged the same day after a check against Harvest). Cards TS-045 to TS-052 come from it; each gets routes, tables, a role table and a goldfish review when it comes up. The "Flows" section of that file names the card that builds each step.

Cards TS-064 to TS-089 come from `docs/research/harvest-b2b.md`, observed in Harvest's application with rea on 2026-11-11. Its cards B3 to B22 are TS-065 to TS-084, kept in this build order: TS-065 B22, TS-066 B4, TS-067 B5, TS-068 B8, TS-069 B7, TS-070 B9, TS-071 B6, TS-072 B17, TS-073 B10, TS-074 B11, TS-075 B16, TS-076 B19, TS-077 B12, TS-078 B13, TS-079 B15, TS-080 B18, TS-081 B20, TS-082 B14, TS-083 B21, TS-084 B3. B1 and B2 are in TS-061 with TS-040 and TS-042. TS-085 to TS-089 are what the owner asked for that the research leaves out. The owner's decisions: a Finance role (from TS-064), a lock date, rates seen only by owners, admins and Finance, never managers, an activity log kept 730 days, and invoicing before import. The tables of every card are in TS-064's schema.

### TS-113b · Fast at company size, the rest

From TS-113 (`research/corporate/scale-test.md`, D8 and D9, and its "After TS-113" section). Waits for TS-111d and TS-111e, which change Approvals, Time off and Work schedules; the lines below are at `ts-113-scale` (a3d335a) and will move.

- [ ] **The shorter day index goes.** A migration that ships alone takes away `time_entries_organisation_id_spent_on_idx`, which the wider `(organisation_id, spent_on, started_at, id)` of 0028 makes redundant (decision 58), with `EXPLAIN QUERY PLAN` showing the same plans without it.
- [ ] **Page Approvals, Time off and Work schedules** at 50 people with a name or address search, as Team and Default rates do (decision 58): Approvals sends 491 KB for an owner of 300, Work schedules 450 KB.
- [ ] **Uninvoiced's date bound.** `uninvoicedTime` and `uninvoicedExpenses` (`app/invoices/sources.server.ts:137` and `:226`) read every uninvoiced entry and expense of the chosen projects, of all time, and the approved periods that hold them (`:197`): 13,953 rows on Invoices → Uninvoiced, and 2,814 entries and 8,935 periods of an owner's Dashboards (22,713 rows).
- [ ] **Expenses' limits.** `expensesOf` (`app/expenses/expenses.server.ts:404`) and `expenseTotalsOf` (`:468`) read every expense in the range with no limit; the list grows by about 7,000 a year.
- [ ] **Page the console's lists.** Organisations (108 KB at 121 organisations) and Log (193 KB) list everything (`app/routes/platform/organisations.tsx`, `app/routes/platform/log.tsx`).
- [ ] **Repeated reads in one request** (not through `remembered`, so the memo of decision 58 does not serve them):
  - Leave (Time off): the schedule book and places, three times for a decider (`app/routes/app/time-off.tsx:124` `timetableFor`, `app/leave/leave.server.ts:221` `myLeave`, `:639` `requestsToDecide`, through `app/schedules/schedules.server.ts:40` `scheduleBookOf` and `:99` `placesOf`); `leave_kinds` three times (`leave.server.ts:220`, `:638`, `:849`); `public_holidays` three times (`time-off.tsx:125`, `leave.server.ts:222`, `:655`); the viewer's `team_members` twice (`leave.server.ts:494` `someoneElseDecides`, `:834` `teamLeaveAhead`); the viewer's time zone twice (`time-off.tsx:111`, `app/teams/people.server.ts:67`).
  - Approvals: the schedule book and places twice (`leave.server.ts:163` `leaveContext`, `:639`); `leave_kinds` twice (`:162`, `:638`); `public_holidays` twice (`:164`, `:655`); `memberships` of the same people (`app/approvals/approvals.server.ts:81`, `schedules.server.ts:105` twice); names by id twice (`approvals.server.ts:92`, `leave.server.ts:659`); the viewer's time zone twice (`app/routes/app/approvals.tsx:129`, `people.server.ts:67`).
  - Work schedules: every membership twice (`schedules.server.ts:105` `placesOf`, `people.server.ts:62`); every team twice (`schedules.server.ts:107`, `app/routes/app/schedules.tsx:136`); the viewer's time zone twice (`schedules.tsx:137`, `people.server.ts:67`).
  - Reports: every project and client twice (`app/reports/sums.server.ts:114`, `app/projects/money.server.ts:75`).
- [ ] **The reads TS-111d, TS-111e and TS-111f added.** For a manager of 120 of 150 people, Timesheet day reads 55 statements (50 before them) and Team 35 (33): the dated rules, leave and weeks for the day's limits, the people's zones, and the lock date as it reaches the person, twice (`test/organisations/request-memo.test.ts`). None reads memberships or teams again; read each once a request and bring the counts back down.

### TS-056 · Timesheet as Harvest has it: Track time, the week's days, submit from the day, getting started

Depends on: TS-012a, TS-013, TS-046, TS-052. From `docs/harvest-comparison.md`, observed in Harvest's application with rea on 2026-11-11.

- [ ] "Track time" is the Day view's one primary action. Its sheet asks for the project, a description and hours; with no hours its action is "Start timer", with hours (`1.5`, `1,5`, `1:30`) "Save entry", which places the entry with `gridEntryStart` on the day shown. A locked day refuses it (tests).
- [ ] Above the day, the period's seven days, each a link to its day with its total, the day shown marked, and the period's total (test, and totals equal the Week view's).
- [ ] The Day view's foot holds the period's status and its one submission action, the same action as the Week view's (test).
- [ ] Getting started on Timesheet: add a project, track an entry, open the week, "n of 3"; each step ticks from what the database holds; "Put away" hides it for that person; it is gone once all three are done (tests).
- [ ] Keyboard alone and axe with WCAG 2.2 AA at 390px and 1280px in both schemes (browser test).

### TS-057 · Projects and Clients as Harvest has them: search, grouped by client, hours spent

Depends on: TS-011a, TS-011b. From `docs/harvest-comparison.md`.

- [ ] Projects has a search field, by project or client name, kept in the address (`?q=`), that narrows the list on the server (test).
- [ ] Projects are listed under their client's name, clients in name order, then "No client"; while Clients is off there are no groups (test).
- [ ] Each project shows the hours tracked on it to date, finished and running entries alike, summed in one query (test, and a property test that it equals the entries' sum).
- [ ] Clients has a filter field by name, kept in the address (test).
- [ ] Keyboard alone and axe at 390px and 1280px (browser test).

### TS-058 · Team's week and Approvals as Harvest has them: totals, filter, status and grouping

Depends on: TS-045, TS-047. From `docs/harvest-comparison.md`.

- [ ] Team > This week shows the week's total hours above the people and a filter by name, kept in the address (test).
- [ ] Approvals has a status choice, Pending, Approved, Returned and Not submitted, in the address (`?status=`), replacing its tabs, and a grouping by person or by project (`?group=`), each with the period's total hours (tests per role).
- [ ] Keyboard alone and axe at 390px and 1280px (browser test).

### TS-059 · Reports stepped by range

Depends on: TS-014a. From `docs/harvest-comparison.md`.

- [ ] Beside the range, "Previous" and "Next" move it by its own length: a week by a week, a month by a calendar month, a custom range by its number of days; the address changes and the report follows (tests, including a month that ends on the 31st).
- [ ] Keyboard alone and axe at 390px and 1280px (browser test).

### TS-046 · Timesheet periods and submission

Depends on: TS-012b, TS-013.

- [ ] An organisation has a timesheet period (a week by default); a person's entries for a period can be submitted once, after which they cannot be edited unless the submission is withdrawn before a decision or the period is returned (tests).
- [ ] The Week view has "Submit week" at its foot, with a confirmation, and its header shows Not submitted, Submitted, Approved or Returned (test).
- [ ] A person withdraws a submission that has not been decided, and can edit again; the withdrawal is recorded (test).
- [ ] The Today destination is renamed Timesheet, with Day and Week views and a History tab; History lists each past period with its status (draft, submitted, approved, returned) (test).
- [ ] A returned period shows the reason and can be corrected and submitted again (test).
- Open for the owner: the default period, and whether a submission requires a full set of expected hours.

### TS-049 · Notifications and reminders

Depends on: TS-046, TS-047.

- [ ] A notification is created for: a reminder to submit, an approval request, a returned period, an approval outcome; each opens its record (tests).
- [ ] A manager, admin or owner sends a reminder from Approvals, Not submitted, to one person or all listed (test).
- [ ] The header shows the number unread; opening one marks it read (test).
- [ ] A person turns each kind of email reminder on or off in My account (test).

### TS-050 · Help and support

Depends on: nothing beyond what is built.

- [ ] A help page reachable from the profile menu, with the questions a person asks in the first week, and a way to report a problem that reaches the owner (test that the link resolves and the report is received).
- [ ] The page answers each flow of `docs/navigation.md`, "Flows", that is built: first sign-in, tracking time, submitting a week, approving or returning, a report and its export, inviting a person.

### TS-051 · The timer in the navigation

Depends on: TS-012a.

From the check against Harvest in `docs/navigation.md`: Harvest's sidebar starts with a Timer button, and a running timer is stopped from the navigation on any page.

- [ ] On every page of an organisation, the navigation holds the timer's control before its first link. With nothing running it is "Start timer", which opens the Day view with the timer's form; with an entry running it shows the project, the time elapsed and "Stop" (test).
- [ ] "Stop" in the navigation stops the person's running entry through TS-012a's `stop`, and the person stays on the page they were on (browser test).
- [ ] The navigation and the Day view show the same elapsed time to the second, and the control reads its state again as the Day view does, when the window gains focus and every 30 seconds (browser test with a controlled clock).
- [ ] The control is worked with the keyboard alone, has an accessible name and is not announced every second; axe with WCAG 2.2 AA tags reports no violations at 390px and 1280px (browser test).

### TS-052 · A week's hours typed in a grid

Depends on: TS-012b; for locked periods TS-046.

From the check against Harvest in `docs/navigation.md`: Harvest's Week view is a grid of projects by days, with a row added per project and hours typed into each day.

Decided by the owner on 2026-11-11: an hour typed into a cell becomes one entry, which starts when the last entry of that day ends, or at 09:00 in the person's time zone when the day has none, and lasts the hours typed. A Timesifier entry has a start and an end (TS-012a) and a cell holds only a number of hours; Harvest offers its grid only to accounts that track durations, not start and end times. The rule is `gridEntryStart` in `app/time/` (TS-053).

- [ ] The Week view shows a row for each project with time that week, and "Add row" adds one. Hours typed into a day's cell are saved, and a cell emptied removes that project's time on that day (tests).
- [ ] A cell that holds more than one entry, or a running one, shows its total and is changed in the Day view (test).
- [ ] "Copy last week's rows" adds the projects of the week before with empty cells; no hours are copied (test).
- [ ] A day in a submitted or approved period cannot be changed from the grid (test).
- [ ] Each day's total and the week's total equal the sums of their cells (property test).
- [ ] The grid is worked with the keyboard alone, from cell to cell, and axe with WCAG 2.2 AA tags reports no violations (browser test).

### TS-037 · The signed-in product in the landing page's direction

Depends on: TS-030 and TS-036. Asked for by the owner on 2026-11-11. It enters Ready when TS-036 is pulled. It builds no timer and no feature card: Today, Reports and Projects stay empty until their own cards.

- [ ] `docs/design-direction.md` holds the written convention for the shell, a form page, a list page, and an empty or error state.
- [ ] One page, Settings, is built to the convention and seen by the owner before any other page is changed.
- [ ] The shell follows the convention at 390px and 1280px in both schemes (browser test, and screenshots the owner has accepted).
- [ ] The organisation chooser at `/app` and the page that creates an organisation at `/app/new` follow it.
- [ ] Members and invitations at `/app/:organisation/settings/members` follow it.
- [ ] The invitation page and its "no longer valid" state follow it.
- [ ] The not-found page and the error page each have a heading, one sentence and one way out (test).
- [ ] Today, Reports and Projects are honest empty states: each says what will be there and offers nothing that does not work (test).
- [ ] A test follows every link a signed-in owner and a signed-in member can reach, and each answers 200 or leads to an element on the page.
- [ ] The existing behaviour and tests of navigation, focus and transitions are kept: `e2e/shell-navigation.spec.ts`, `e2e/shell-transitions.spec.ts`, `e2e/shell-accessibility.spec.ts` and `e2e/reduced-motion.spec.ts` pass, changed only where a name on the page changed.

### TS-022a · Recovery and one alert

Depends on: TS-003. Done before TS-012a is pulled. The 5% figure and the one hour below are proposals; the owner confirms them by approving this board.

- [ ] An in-place Time Travel restore has been rehearsed on `timesifier-preview`, and an export of that database has been imported into a scratch database. The steps and the date are on this card.
- [ ] The pipeline prints `wrangler d1 time-travel info timesifier` before it applies migrations to production, so the log of every deploy holds the point to return to.
- [ ] The smoke test makes one check through D1: `POST /api/auth/sign-in/email-otp` with a well-formed wrong code answers 400, not 500.
- [ ] When more than 5% of requests are answered 5xx over 5 minutes, or one `email: send failed` line is logged, an email reaches the owner. Each has been triggered once on purpose, and the date is on this card.
- [ ] No log line holds an entry's description (test).
- [ ] `docs/architecture.md` states the recovery point (any minute of the last 30 days) and the recovery time (one hour).
- [ ] `docs/security.md`, "Known gaps and accepted risks", says that the only copy of the data is the database's own history until TS-022b.

From TS-027: an unexpected error is now logged as its name and the path, and nothing else. That keeps addresses and tokens out of the log, and it also keeps out what a person needs to find the fault. This card adds the stack without its message line, and a request id, to that line.

### TS-043 · A ceiling on the email the application sends

This card was TS-032 until 2026-11-11, when that number went to the card that took the deployment's settings out of the code.

Depends on: nothing. Done before TS-030 is deployed: anyone may make an account, and today nothing bounds the total number of messages.

- [ ] One client address is sent at most a fixed number of sign-in codes a day, whatever addresses it names; the next request is answered like a served one and nothing is sent (test). The number is written in `docs/architecture.md`.
- [ ] The application sends at most a fixed number of messages a day in all, set below the Email Service quota; above it nothing is sent and one line is logged (test). The number is written in `docs/architecture.md`.
- [ ] Both counts are kept under a keyed hash or a fixed name, never an address (test).

### TS-021a · Account deletion

Depends on: TS-012a. Moved ahead of reports by the owner on 2026-11-11, because anyone may make an account.

- [ ] A signed-in person can delete their account from Settings. The confirmation is a sheet in which they type the account's email address.
- [ ] Deleting an account ends every session of the person and removes their memberships, and the invitations they sent.
- [ ] Time entries keep their `user_id`. The `users` row stays; its name becomes "Deleted person" and its address becomes a value that identifies nobody and can receive no mail. A test lists every table with a column that refers to a person and checks each; it fails when a table is added and not listed.
- [ ] The last owner of an organisation with other members must hand it over first; the sheet says so and nothing is deleted (test).
- [ ] The privacy page says how to delete an account, in the words of the Settings page.

### TS-012b · Manual entries

Depends on: TS-013.

Not Ready. One decision is open, and it is the owner's: whether `style` attributes stay banned by the Content Security Policy. React Aria's date and time components write them. Either the policy gains `style-src-attr 'unsafe-inline'` and the components are used as shipped, or the ban stays and this card builds date and time fields on React Aria's hooks. The answer becomes decision 28 before this card enters Ready. TS-014a's date range waits on the same answer.

- [ ] A person can add, edit and delete their own entries by hand; an end before its start is rejected (test).
- [ ] An owner or admin can see another member's entries and cannot change them (a test for every cell of this card's role table).
- [ ] An entry can be added from the keyboard alone, without the pointer (browser test).
- [ ] A day and a time typed by a person are read in the person's time zone (decision 26); a time that does not exist on that day, in the hour a clock change skips, is rejected (test).

### TS-039 · Month and year views

Depends on: TS-013.

No routes or tables are written here yet. When this card comes up it gets them, a role table and a goldfish review (`docs/ways-of-working.md`), like the cards in Ready.

TS-062 builds the month as Timesheet's calendar: each day's total, each week's (the Week view's, so a week that crosses the end of the month shows its whole total and the weeks do not add up to the month) and the month's (its own days only). What stays here is the year, and the month's totals by project.

- [ ] The month's totals by project, in the person's time zone, and the month's (test).
- [ ] The year view shows one calendar year: a total for each month, each project, and one for the year (test).
- [ ] For random sets of entries, the month's total equals the sum of its day totals and the sum of its project totals; the year's total equals the sum of its month totals and the sum of its project totals; and a month's total in the year view equals the month view's total for that month (property test).
- [ ] An entry belongs whole to the local day it starts in (decision 26): one from 23:30 on the last day of a month to 00:30 is counted in the first month only (test).
- [ ] With two members in one organisation, neither view shows the other's entries or counts them in a total (test).

### TS-020 · Audit log

Depends on: TS-009.

- [ ] A table `audit_records` with the columns `id`, `organisation_id` (null for an event outside any organisation), `actor_user_id` (null when nobody was signed in), `action`, `subject`, `created_at`.
- [ ] Sign-in, role change, invitation, export and deletion each write a record. A failed sign-in is recorded without an organisation, under a keyed hash of the address.
- [ ] Records cannot be changed or deleted through the application (test).
- [ ] An owner or admin can read their organisation's records and no other organisation's; a member cannot (test).
- [ ] No record contains a secret, a session token or entry text (test).
- [ ] Audit records keep their user id. Account deletion removes the person's name and address, and the id then shows as "Deleted person". This is the one exception in TS-021a's table test.
- [ ] A record is kept for a fixed period, written in `docs/security.md`; older records are deleted by TS-033's job.

### TS-021b · Export of personal data

Depends on: TS-014b, TS-020 and TS-018. Which of the last two stays in release 1 is an open question for the owner; this line follows the answer.

- [ ] A person can download everything held about them as JSON.
- [ ] `docs/data-protection.md` lists what personal data is held, why, where, and for how long.

### TS-015 · AI category suggestions

Depends on: TS-012a.

Not Ready: the model, the accuracy it must reach, the daily spend limit and what a person sees when the model fails are not decided.

- [ ] For an entry with a description, the application suggests a project; the suggestion is applied only when the person accepts it.
- [ ] A labelled set of at least 30 example entries is committed; `pnpm eval:categories` reports accuracy, and the threshold it must meet is written on this card before the first run.
- [ ] A description that contains instructions ("ignore the above and…") produces a project suggestion or none, never different behaviour (test with at least 5 such inputs).
- [ ] Requests go through AI Gateway with a daily spend limit; the limit is written in `docs/architecture.md`.
- [ ] The model receives the description and the organisation's project names, nothing else (test inspects the request).

### TS-016 · Calendar import

Depends on: TS-013.

Not Ready: the key the address is encrypted with and how it is replaced, the defence against an address that passes the check and then resolves somewhere else, and how often a feed is read again are not decided.

- [ ] A person can add a calendar by its ICS address; its events appear beside tracked time in Today and Week.
- [ ] The address is fetched by the server only if it is `https` and resolves to a public address; private, loopback and link-local addresses are refused (test).
- [ ] The calendar address is stored encrypted and never returned to the browser after saving.
- [ ] A feed that fails or exceeds 5 MB shows the text "This calendar could not be read. The events already imported are unchanged." and leaves existing events in place (test).

### TS-017 · Focus blocks

Depends on: TS-016.

The owner, 2026-11-11: a focus rhythm in the Pomodoro manner, stretches of work and breaks. Open for the owner: how long a stretch and a break are, whether a person can change them, and whether a break is planned like a block or only timed. The criterion for the rhythm is written when the answer is.

- [ ] A person can plan a focus block on a day; it appears in Today and Week.
- [ ] A block that overlaps a calendar event shows the text "This block overlaps" followed by the event's title before it is saved, and it can still be saved (test).
- [ ] At the end of the day the view shows planned focus time beside the time actually tracked during those blocks; the two figures are covered by a test.

### TS-041 · The team calendar

Depends on: TS-061 and TS-013. It does not need TS-016: events read from an outside calendar are that card's.

No routes or tables are written here yet. When this card comes up it gets them, a role table and a goldfish review (`docs/ways-of-working.md`), like the cards in Ready. TS-062 builds a person's own calendar of tracked entries, by week and by month, with a place on each day for a status such as leave; this card adds the leave and the team's calendar.

Settled by the owner on 2026-11-11, on TS-061: everyone may be told that a colleague is on leave; the person, the managers of their teams, owners and admins see the kind.

- [ ] A person's calendar shows, for a chosen week or month in their time zone, their tracked entries and their approved leave, each on the local day it belongs to (test).
- [ ] A team's calendar shows the same for every member of the team, to a manager of that team and to an owner or admin (a test for every cell of this card's role table).
- [ ] A manager's calendar shows nobody from a team they do not manage (test with two teams).
- [ ] The hours shown for a person's day on the calendar equal that day's total in their week view (property test).
- [ ] The calendar can be moved through with the keyboard alone, and axe with WCAG 2.2 AA tags reports no violations (browser test).

### TS-065 · B22 · Deadline and lock date

Depends on: TS-064, TS-046, TS-047.

- [x] An owner or admin sets a timesheet deadline (weekly on a day and time, or monthly on a date, in the organisation's time zone) (test). Workspace settings › Timesheet locking (`app/locks/LockSettings.tsx`, `lockAction`); Finance, a manager and a member get the 404 of Workspace settings and nothing changes (`test/pages/lock-date.test.ts`, "lets %s set the lock date: %s", "sets a weekly or a monthly deadline, with auto-lock and auto-submit, in the organisation's zone"; `test/locks/deadline.test.ts`, "the deadline"; `e2e/governance.spec.ts`, "a weekly deadline with auto-lock is set on Timesheet locking").
- [x] An owner or admin sets a lock date up to today. No entry, expense or leave on or before it can be created, edited or deleted by anyone, owner included, until the lock date is moved back, which is recorded in the activity log (test per role, Finance included). Time and leave: the lock date is set up to today and moved back or removed only with a reason, kept in the activity log (`test/pages/lock-date.test.ts`, "refuses a lock date after today, in the organisation's zone", "moves the date back, or removes it, only with a reason, which the activity log keeps"); every role, Finance included, "can neither add, change nor delete time on or before it, and can after it"; leave "refuses leave asked for on or before it, and deciding or withdrawing leave that reaches it"; the Day view "tells the person why" (and `e2e/governance.spec.ts`, set with the keyboard alone). Expenses (TS-092): every write calls `lockReasonsOn` and `invoicedIds` (`lockOfWrite` in `app/expenses/expenses.server.ts`), the refusal names the date and the owner's reason, and the Expenses page shows the lock notice (`test/pages/expenses.test.ts`, "refuses recording, changing and deleting on or before it for every role, naming the reason", owner, admin, Finance, manager and member; "refuses deleting an expense on an invoice, and Approvals still totals the week").
- [x] Optional auto-lock: N days after each deadline, the lock date moves forward to the deadline. It never moves backward (test with a fake clock). `deadline.ts` with the hourly Cron Trigger in `workers/scheduled.ts` (`test/locks/deadline.test.ts`, "auto-lock"; `test/pages/lock-date.test.ts`, "auto-locks N days after each deadline, never backward, and submits as the system when asked").
- [x] Optional auto-submit at lock: every unsubmitted period up to the lock date becomes submitted, recorded as "submitted by the system" (test). Its `period_events` row has a null actor (migration `0013_lock_date`) and its activity record source `system` (`test/pages/lock-date.test.ts`, "submits every unsubmitted week up to the new lock date, as the system").

### TS-070 · B9 · Expenses

Depends on: TS-064, TS-011a, TS-046, TS-047.

Builder: an AI session on branch `ts-b2b-expenses`, migration `0012_expense_category_prices` (a unit price from a date). Receipts need the R2 buckets `timesifier-receipts` and `timesifier-receipts-preview`, created with `--jurisdiction eu`, before it deploys.

- [x] An owner or admin keeps expense categories (name, optional unit price and unit); archive and restore. Changing a unit price applies to expenses dated from the change (test). (`test/pages/expenses.test.ts`, "expense categories in Workspace settings")
- [x] A person records an expense: date, project, category, amount or quantity, note, billable (defaulting from the project), "reimburse me". Amounts are stored in minor units of the project's currency (test). (`test/pages/expenses.test.ts`, "recording an expense"; `test/expenses/expenses.test.ts`)
- [x] A receipt (PDF, PNG or JPEG, up to 10 MB) is stored in R2 under an organisation-scoped key. It is served only to people who may see the expense; anyone else gets 404, including people in another organisation (test). (`test/pages/expenses.test.ts`, "receipts")
- [x] Expenses in a period are submitted, withdrawn, approved and returned with the period's time, and are locked with it and by the lock date (test). (`test/pages/expenses.test.ts`, "locks", with an invoice too; Approvals shows them, "Approvals")
- [x] A person sees and changes their own expenses; a manager sees their teams' people's, an owner, admin or Finance everyone's, and only the person changes them (`maySeeExpensesOf`, `mayChangeExpensesOf`; role table). (`test/pages/expenses.test.ts`, "who sees whose expenses")
- [x] Reports include an Expenses view and CSV by person, project and category, with billable and reimbursable totals (test). (`test/pages/expenses.test.ts`, "the Expenses view of Reports"; `e2e/expenses.spec.ts`)
- [x] Out of scope, said on the card: paying reimbursements.

### TS-072 · B17 · Activity log

Depends on: TS-064, TS-020, TS-046. It extends TS-020, which keeps the security events; TS-064 lays the writer and the table.

- [x] Creating, editing (with the changed fields' old and new values), deleting, starting and stopping a timer on a time entry, and every period action each write a record with actor, owner of the entry, organisation and source (web, import, API) (test per action). The web and the system: `test/activity/activity.test.ts`, "a timer started, by and about the person, without its description", "an entry changed, with what it was and what it is, but no description", "a week submitted, by and about the person"; `test/pages/activity.test.ts`, "a timer stopped, a week submitted, withdrawn, approved, reopened and returned", "lists each change with old and new values, and stays after the entry is deleted". The import and API sources (TS-092): `test/integrations/import.test.ts`, "records each imported entry, client, project and task, and each reverted entry, as from the import"; `test/integrations/api.test.ts`, "writes: a person's own entries only, via API in the activity log, and locked days refused".
- [x] Projects, clients, rates, budgets, leave decisions, the lock date, and (with TS-073) invoices, payments and sends write records (test per kind). Projects, clients, leave and the lock date: `test/activity/activity.test.ts`, "a project created, by the person, about the organisation", "a client created, by the person, about the organisation"; `test/pages/activity.test.ts`, "leave asked for, approved, refused, withdrawn and cancelled, by who took each step", "the lock date, shown in the log with its reason". The rest (TS-092), each in the same batch as its change and once only when two arrive together (`recordStatementWhen`), money records belonging to nobody so a manager never sees them: `test/activity/business.test.ts`, per role "a billable rate and a cost rate, set and changed, are each recorded once, as nobody's", "a budget set and removed is recorded on the project's budget", "an expense category created, priced again, archived and restored is recorded each time", "a payment recorded on an invoice's page is recorded as theirs, never with its note"; "a draft made is recorded as created", "issuing is recorded once; a second issue is refused and records nothing", "voiding is recorded once; voiding a void one records nothing", "a payment and a write-off recorded, and a payment deleted, are each recorded", "sending by email records the send with the sent time, and the new billing contact on the client", "created, sent from its page and accepted on the client's link: one record each", "a recurring invoice set up, changed, given a line and stopped is recorded each time, stopping once", "a retainer opened is recorded".
- [x] Review > Activity log shows records for a range, filtered by kind, project, "performed by" and "owned by", with CSV. Owners, admins and Finance see all; a manager sees records about their teams' people and their own; a member sees the history of their own entries, on the entry (`activityScopeOf`; role table). The filters apply as they change (`FilterBar`); an entry's History is on the Day view's Actions menu (`test/pages/activity.test.ts`, "who reads what", "narrows by kind, project, performed by, owned by and range", "exports the same records as CSV, never their descriptions", "is read by the entry's person, their manager and those who read everything, and nobody else"; `test/pages/finance.test.ts`; `e2e/governance.spec.ts`, "the Activity log holds the lock date's change, narrows to its kind, and downloads it", "an entry's History opens from the Day view's Actions menu", and no WCAG 2.2 AA problem at 390 and 1280 in either scheme).
- [x] Entry text (descriptions) is never copied into a record, as TS-020 says. Edits record that the description changed, not what it said (test). `test/activity/activity.test.ts`, "records a changed description, note or comment as a marker, never its text", "never stores free text, even from a summary built by hand". The lock date's reason is the one stated exception, an administrator's statement about the organisation (`docs/security.md`, "Locks").
- [x] Records are kept 730 days, as `docs/security.md` says, then deleted by TS-033's daily job; no record can be changed (test). The daily job is the Worker's `scheduled` handler at 03:17 UTC (`workers/scheduled.ts`), which TS-033 extends with its other tables (`test/pages/lock-date.test.ts`, "deletes activity records older than two years once a day, and no record can be changed"; `test/activity/activity.test.ts`, "retention").

### TS-075 · B16 · Finance role: its column in every role test, and its pages

Depends on: TS-064, TS-073. The role itself exists from TS-064 (owner's decision); this card proves it everywhere.

- [x] Finance sees all time and expenses (read-only), all rates, all invoices, estimates and payments, every report, Dashboards and the Activity log. It cannot manage members, teams, leave policies, tasks, Integrations or workspace settings, and decides no period unless it manages a team (a test for every cell of the extended role table). Every rule of `access.ts` for an owner, admin, Finance, Finance who manages a team, manager and member; Reports and its CSV hold everyone's time for Finance; Timesheet stays its own and another person's entry is refused; Team, Members, Invitations, Workspace settings, Tasks and Integrations 404 with their forms refused; Approvals 404 until Finance manages a team, then that team's periods and leave alone and never its own; Clients read-only, its forms and giving a project a client refused 403 (`mayManageClients`, new: the Clients action let Finance change clients, against `docs/security.md`); the Activity log shows another person's records (`test/pages/finance.test.ts`). Payments are recorded on Invoices, which TS-073 builds.
- [x] Every existing route's role test gains a Finance column (test inventory). The role table in `test/pages/finance.test.ts` has a row for every route of an organisation, read from the built routes, with each role's page and data status and, for every action, a form each role is allowed or refused with nothing changed; a route without a row or an action without a form fails it.
- [x] Each page Finance is shown works for Finance end to end: Invoices, Estimates, Clients, Reports, Dashboards, Activity log (browser test signed in as Finance). A new owner invites a new person as Finance through Team > Invitations, who joins from the email's link and opens each page from the navigation with the keyboard; Reports narrowed to the owner and back to Everyone, and its CSV downloaded; no WCAG 2.2 AA problem at 390 and 1280 in either scheme (`e2e/finance.spec.ts`). Invoices, Estimates and Dashboards are other cards' pages, empty states on this branch, so the check there covers opening and reading them only.

### TS-076 · B19 · Import time from a CSV, and revert it

Depends on: TS-064, TS-066, TS-014b. After invoicing, by the owner's decision.

- [x] An owner or admin uploads a CSV with Harvest's 8 columns (Harvest's own "Export all time" is accepted as is). Each row is matched to a member by email or name. Missing clients, projects and tasks are created. Unmatched people are listed with their rows and nothing from them is imported (test with a fixture of Harvest's export: `test/integrations/import.test.ts`, `test/integrations/fixtures/harvest-time-export.csv`). The Harvest preset chooses the columns by Harvest's headings; others are chosen on the preview.
- [x] A preview shows the rows to import and the rows to skip, with reasons, before anything is written (`test/integrations/import.test.ts`, `e2e/integrations.spec.ts`).
- [x] Each import has an id. "Revert" deletes exactly that import's entries unless one is in an approved, locked or invoiced period, in which case it refuses and names those entries (`test/integrations/import.test.ts`; locks by `app/locks`, which also holds a submitted period).
- [x] Rows already present (same person, date, project, task, hours and notes) are skipped (`test/integrations/import.test.ts`).
- [x] Clients and projects import from a CSV, linked from their own pages for owners and admins (`test/integrations/import.test.ts`).
- [x] TS-014b, amended: an owner or admin can export all of the organisation's time (Integrations › Export all time, `test/integrations/import.test.ts`), and all invoices as one ZIP of PDFs (TS-092: Integrations › "Export all invoices as PDFs", every invoice, drafts and void ones too, each entry byte for byte the invoice's own PDF; `app/lib/zip.ts`, `app/invoices/export.server.ts`; `test/integrations/invoice-export.test.ts`, "gives an owner a ZIP of every invoice's own PDF…", "names two invoices whose numbers read the same in a file name apart", "is an empty ZIP for an organisation with no invoices", "is for owners and admins only…"; `e2e/integrations.spec.ts`, "every invoice as a PDF in one ZIP, downloaded with the keyboard").

### TS-079 · B15 · Contractors

Depends on: TS-064, TS-071.

Builder: an AI session in the governance slice, on branch `ts-b2b-governance`. Harvest flags any person Contractor at any role, and Reports › Contractor (admins only) shows each contractor's unrounded hours and cost for a range, with archived contractors who tracked in it (`docs/research/harvest-b2b.md`, section 8). The tests below are written; the slice's run of the worker tests and the Chromium project is what proves them.

- [x] An owner or admin marks a member as employee or contractor (test). Team › Members' Actions menu gains "Mark as contractor" or "Mark as employee", and the row says "Contractor" beside the role. An owner marks anyone, themselves included; an admin anyone whose role they may change. Finance, a member and a manager are refused (404 of Team, or 403) and nothing changes. Each change is `membership.contractor_changed` in the activity log with `isContractor` before and after, about the member; a removal and a leaving (now recorded, from My account) keep `isContractor` in `before` (`app/routes/app/members.tsx`, `app/routes/app/account.tsx`, `mayMarkContractor` in `app/contractors/contractors.ts`; `test/pages/contractors.test.ts`, "marking a member as an employee or a contractor"; `e2e/contractors.spec.ts`, by keyboard alone).
- [x] A Contractors report lists each contractor's unrounded hours and cost for a range, including people who left the organisation if they tracked in it, with CSV. Owners, admins and Finance only (role table). At `reports/contractors` and `reports/contractors/export`, with Reports' ranges and Previous and Next; a member, a manager and another organisation get the organisation's 404. Hours are whole seconds; cost is each entry's seconds at the cost rate in force on the day it starts in the person's zone (`resolveRate`), added exactly and rounded half up once per person and currency, one total per currency; time with no cost rate counts 0 and says "Missing rate for h:mm". A person who left is listed when their last `membership.removed` record says they were a contractor; their entries stay when their membership goes. The CSV has seconds and hours to six places, one row per currency and one for time without a rate (`app/contractors/`, `app/routes/app/contractors.tsx`, `contractors.export.ts`; `test/pages/contractors.test.ts`, "the Contractors report": a rate change mid-range, a missing rate, a project rate in euros, a departed contractor in and a departed employee out, a day in Auckland, the CSV's headers and rows; `test/pages/destinations.test.ts`, `test/pages/isolation.test.ts`; `e2e/contractors.spec.ts`: time tracked on the Timesheet shows with "Missing rate", the download, axe at 390px and 1280px in both schemes).
- [x] Reports links to the Contractors report for those who see rates: Contractors is a tab of Reports beside Expenses (TS-092, `REPORT_VIEWS` in `app/reports/views.ts`), shown to owners, admins and Finance and 404 to others (`test/pages/expenses.test.ts`, "for the %s, Contractors shown: %s", per role; `e2e/contractors.spec.ts`).

### TS-081 · B20 · Public API with organisation tokens

Depends on: TS-064, TS-020, TS-072 (for "via API").

- [x] An owner or admin creates and revokes API tokens on Integrations. A token is shown once, starts `tsf_`, is stored as a keyed hash, carries the scopes chosen at creation and shows when it was last used (`test/integrations/api.test.ts`, `e2e/integrations.spec.ts`).
- [x] Read endpoints for projects, clients, tasks, time entries and leave, and write endpoints for time entries, obey the same role rules as the pages (shared role-table test). Writes appear in the activity log "via API" (`test/integrations/api.test.ts`: owner, admin, Finance, manager, member, contractor). Users, expenses and invoices are read too; `docs/api.md` and `docs/openapi.yaml` describe it.
- [x] A rate limit per token. Exceeding it returns 429 with Retry-After (`test/integrations/api.test.ts`: 100 requests in any 15 seconds).

### TS-082 · B14 · Client view and online payment

Depends on: TS-064, TS-074. Later than TS-073 to TS-078.

- [ ] A per-client secret link, revocable, shows that client's open invoices and recent payments, and nothing of any other client (test).
- [ ] Stripe Checkout on an open invoice. A verified webhook records the payment once, even if delivered twice (idempotency test).
- [ ] UBL 2.1 XML export of an issued invoice validates against the PEPPOL BIS 3.0 schema (test). Peppol sending is out of scope.

### TS-083 · B21 · Xero connection

Depends on: TS-064, TS-074, TS-088. A connector card per provider follows the same shape.

- [ ] An owner or admin connects Xero by OAuth. Issuing an invoice in Timesifier creates the same invoice (contact, lines, tax, currency, number) in Xero once, and a retry never duplicates it (idempotency test against a recorded fixture).
- [ ] A payment recorded in Xero is read back and recorded on the Timesifier invoice (test).

### TS-087 · Webhooks

Depends on: TS-064, TS-081, TS-072. Asked for by the owner.

- [x] An owner or admin adds a webhook on Integrations: an `https` address and the events it receives (entries, periods, expenses, invoices, payments) (`test/integrations/webhooks.test.ts`).
- [x] Each delivery is signed `t=…,v1=…` with HMAC-SHA-256 under a secret derived from `BETTER_AUTH_SECRET`, the webhook's id and its version, shown once and never stored; rotating raises the version and the old secret stops working (`test/integrations/webhooks.test.ts`).
- [x] A failed delivery is retried with backoff; after repeated failures the webhook is switched off and its owner told; its last status and failures are shown (test with a fake clock: `test/integrations/webhooks.test.ts`; the cron trigger runs the dispatcher every minute).
- [x] A delivery holds what the reader's role would see through the API, and no entry description unless the scope allows it (`test/integrations/webhooks.test.ts`).

### TS-089 · Calendar feed

Depends on: TS-064, TS-061, TS-012a. Asked for by the owner; carries B3's ICS feed.

- [x] A person subscribes to an ICS feed of their approved time off and their entries; a manager to one per team they manage, of approved leave only (role table: `test/integrations/feeds.test.ts`).
- [x] The feed's address is secret, stored as a keyed hash, and revocable; revoking it makes the old address answer 404 (`test/integrations/feeds.test.ts`, `e2e/integrations.spec.ts`).
- [x] Entries appear on the local day they start, in the person's time zone, and descriptions only on the person's own feed (`test/integrations/feeds.test.ts`).

### TS-018 · Weekly summary

Depends on: TS-017.

Not Ready: what the summary is (a page, an email or both) is not decided. When it is, the job is an hourly Cron Trigger that serves every person whose local time is between 07:00 and 07:59.

- [ ] Each Monday at 07:00 in the person's time zone, a summary of the previous week is produced: total time, the three largest projects, focus time planned and achieved.
- [ ] The figures equal those of the report for the same week (test).
- [ ] The job can be run again for the same week without producing a second summary (test).
- [ ] A person can turn the summary off, and it then stops.

### TS-019 · Threat model

Depends on: TS-014a, once a real person has used reports.

- [ ] `docs/threat-model.md` has one section for each row of "Parts" in `docs/architecture.md`, with its assets, entry points and threats; a test fails when a part has no section.
- [ ] Every threat is rated high, medium or low and names either a control already in place, a card that will add it, or the date the owner accepted it.
- [ ] No threat rated high is left without a control or a card.

### TS-023 · Accessibility audit

Depends on: the last card that builds a page in release 1.

- [ ] axe with WCAG 2.2 AA tags runs in the pipeline on every route in the route configuration, read from it as `test/auth/guard.test.ts` reads it, and reports no violations.
- [ ] Every task in "What success looks like" in `docs/product.md` has been completed by keyboard alone, and with VoiceOver in Safari; findings are listed on this card and fixed.

### TS-024 · Performance budget

Depends on: the last card that builds a page in release 1, and TS-014a used by a real person. The conditions below are proposals; the owner confirms them by approving this board.

- [ ] The pipeline measures the home page, Today and Reports with Lighthouse, on its mobile profile (simulated slow 4G, CPU slowed four times), against the production build the browser tests serve, signed in as a seeded person whose organisation holds 500 entries over 8 weeks. It takes the median of 5 runs.
- [ ] It fails when Largest Contentful Paint exceeds 2.5 s or Cumulative Layout Shift exceeds 0.1 on any of the three pages.
- [ ] Interaction to Next Paint is measured by a browser test that starts and stops the timer on Today five times under the same CPU slowdown; it fails when the slowest interaction exceeds 200 ms.
- [ ] The budget and these conditions are written in `docs/architecture.md`.
- [ ] Whether to turn on smart placement, join the membership queries into one, or set a limit on queries per request is decided here, from the measurements.

### TS-025 · Public pages: metadata, and links from every page

Depends on: TS-030, which took this card's home page, privacy page and terms page.

- [ ] Each public page has a title, a description and a social preview image, and is server rendered (a test finds each in the HTML the server sends).
- [ ] The privacy page and the terms page are linked from every page, signed-in pages included (a test walks the route configuration).

### TS-022b · A nightly copy of the database

Depends on: TS-022a.

- [ ] A nightly export of the production database is written to an R2 bucket created with `--jurisdiction eu`, and one export has been imported into a scratch database.
- [ ] Exports older than a fixed period, written in `docs/architecture.md`, are deleted.

### TS-033 · Delete expired rows every day

Depends on: TS-013.

- [ ] A daily Cron Trigger deletes rows of `verifications`, `sessions` and `invitations` that expired more than a fixed period ago; the period for each is written in `docs/architecture.md`, "Tables" (test with a fixed clock).
- [ ] The job can run twice in a day without error (test).

### TS-034 · Rehearse cancelling a preview that is still being created

Depends on: nothing. Left over from TS-026.

- [ ] A pull request is closed while its `preview` job is running; the job is cancelled, and no preview exists afterwards. The run numbers are on this card.

### TS-035 · Show the secret scan failing

Depends on: nothing. Left over from TS-002.

- [ ] A throwaway pull request that adds a made-up value in the shape of a real key shows a failed `secret scan`; it is then closed and its branch deleted.

## Done

The newest first. Each card, with its criteria and their evidence, is in `docs/board-done.md`.

- TS-113 · Fast at company size. Done 2026-11-23, pull request #84.
- TS-111e · The rules hold together, part 3: leave, the day's rules and their records. Done 2026-11-23, pull request #80.
- TS-111f · The rules hold together, part 4: the writers and invoices. Done 2026-11-23, pull request #81.
- TS-120 · The console's Brand page. Done 2026-11-23, pull request #74.
- TS-099 · The platform console. Done 2026-11-23, pull requests #60 and #62.
- TS-093 · Taste: the timesheet as Harvest makes it feel. Done 2026-11-23, pull request #55.
- TS-111d · The rules hold together, part 2: locks, approvals and who decides. Done 2026-11-23, pull request #82.
- TS-114 · The Timesheet answers the press. Done 2026-11-23, pull request #69.
- TS-111b · The rules hold together, part 1: every writer stores an entry's day. Done 2026-11-23, pull request #67.
- TS-111a · The rules hold together, part 1: room for an entry's day. Done 2026-11-23, pull request #66.
- TS-112 · Lists of any length. Done 2026-11-22, pull request #70.
- TS-119 · Expense categories from day one, and Invoices opening on what's owed. Done 2026-11-22, pull request #72.
- TS-097 · Work schedules. Done 2026-11-13, pull request #59.
- TS-096 · Loading and motion like Royal London. Done 2026-11-13, pull request #57.
- TS-095 · Expected hours as a ceiling, overtime recorded as such. Done 2026-11-12, pull request #58.
- TS-092 · Wiring between the business features. Done 2026-11-12, pull request #56.
- TS-073 · B10 · Invoices from tracked time and expenses (draft and issue). Done 2026-11-12, pull request #46.
- TS-077 · B12 · Estimates. Done 2026-11-12, pull request #46.
- TS-078 · B13 · Recurring invoices and retainers. Done 2026-11-12, pull request #46.
- TS-088 · Xero CSV export of invoices. Done 2026-11-12, pull request #46.
- TS-068 · B8 · Utilisation report. Done 2026-11-12, pull request #52.
- TS-071 · B6 · Cost rates and profitability. Done 2026-11-12, pull request #52.
- TS-080 · B18 · Saved and shared reports. Done 2026-11-12, pull request #52.
- TS-086 · Dashboards. Done 2026-11-12, pull request #52.
- TS-066 · B4 · Tasks and billable time. Done 2026-11-12, pull request #48.
- TS-067 · B5 · Project types and billable rates. Done 2026-11-12, pull request #48.
- TS-085 · Tags. Done 2026-11-12, pull request #48.
- TS-090 · Leave and time together: limits, notice, overtime and weekend work. Done 2026-11-12, pull request #45.
- TS-091 · The audit's fixes, first pass. Done 2026-11-12, pull request #44.
- TS-063 · The profile menu. Done 2026-11-11, pull request #40.
- TS-055 · A signed-in person never sees the home page. Done 2026-11-11, pull request #31.
- TS-053 · Foundation for the heading features. Done 2026-11-11, pull request #29.
- TS-032 · Nothing of one deployment in the code. Merged 2026-11-11, pull request #23; the integrator is checking its production deploy.
- TS-008 · Authentication. Done 2026-11-11, pull request #17.
- TS-009 · Organisations and roles. Done 2026-11-11, pull request #20.
- TS-029 · Remove passkeys: the emailed code is the one way in. Done 2026-11-11, pull request #21.
- TS-028 · A text field's label covers what a person types, in Safari. Done 2026-11-11, pull request #19.
- TS-002 · Pipeline: checks on every pull request. Done 2026-11-11, pull request #2.
- TS-027 · Close the findings of the authentication security review. Done 2026-11-11, pull request #18.
- TS-006 · Application shell. Done 2026-11-11, pull request #16.
- TS-005 · Component foundation. Done 2026-11-11, pull request #13.
- TS-026 · Close the findings of the foundation security review. Done 2026-11-11, pull requests #9 and #10.
- TS-004 · Design tokens. Done 2026-11-11, pull request #7.
- TS-007 · Database foundation. Done 2026-11-11, pull request #6.
- TS-010 · Security headers and request checks. Done 2026-11-11, pull request #5.
- TS-003 · Pipeline: preview and production deploys to timesifier.com. Done 2026-11-11, pull request #4.
- TS-001 · Scaffold the application on Cloudflare. Done 2026-11-11, pull request #1.

## Later

Not refined; no acceptance criteria yet. See "After release 1" in `docs/product.md`.

- Paid plans and billing
- Desktop app and browser extension for passive tracking
- iOS and Android apps
- Two-way calendar sync and meeting scoring
- Integrations with chat, task and billing tools
- Team analytics and workload balancing
- The company's name in the emails. The messages name no company (TS-121): the owner decided that emails carry no company name or address until they say otherwise.
- A way to the terms and the privacy notice, and so to the company's details, from the pages that have none: the signed-in application, the unsubscribe page, an invitation's page and an estimate's page (found on TS-121).
