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

## Review (limit 2; a card waiting only on the owner is not counted)

### TS-055 · A signed-in person never sees the home page

Builder: an AI session on branch `ts-055-session`. The owner asked on 2026-11-11 that a signed-in session never shows the landing page, for any reason, until the person signs out. How it works is in `docs/security.md`, "The pages for a person who is signed out".

- [x] A signed-in person who asks for `/` is sent to `/app`, and on to their organisation; a move to `/` from inside the application gets the same as a whole-page redirect (`test/pages/signed-out-pages.test.ts`).
- [x] After signing out, `/` shows the home page again (same file).
- [x] When the session cannot be read, `/` answers with the error page, not the home page (same file).
- [x] Every page and every page's data is sent with `Cache-Control: private, no-store` (same file).
- [x] Going back through a tab's history after signing in never shows the home page; going back after signing out never shows the application (`e2e/auth-journeys.spec.ts`, "the home page and the session", Chromium and WebKit).

### Timesheet slice · TS-012a, TS-013, TS-012b, TS-046, TS-051, TS-052

Builder: an AI session on branch `ts-054-timesheet`. In review: its pull request. Timesheet's Day view (timer, entries, entries by hand), Week view (grid of projects by days, totals, Submit week, Withdraw), History, and the timer's control in the navigation, on the foundation of TS-053. The cards' criteria stay on the cards below; tests: `test/pages/timesheet.test.ts`, `test/timesheet/sheets.test.ts`, `test/db/timesheet-index.test.ts`, `e2e/timesheet.spec.ts`. Two departures from the card texts, both from `docs/navigation.md`: the views are `?view=week` and `?view=history` on Timesheet's own address, not `/week`; the person's zone is set on My account, not Settings. TS-012b uses the browser's own date and time inputs, which write no `style` attribute, so decision 28 is not needed for it. The browser tests create the project on the Projects page (TS-011a). Not yet done: the owner's screenshots.

### TS-053 · Foundation for the heading features

Builder: an AI session on branch `ts-053-foundation`. In review: the pull request against `main`. The owner asked on 2026-11-11 for every feature under the headings of `docs/navigation.md` to be built. The work runs in two waves: this card first, then four slices built side by side, each owning its own pages (Timesheet; Projects, Clients and Workspace settings; Teams, Team and Approvals; Reports and the CSV export). This card lays what the four share: the navigation by heading and role, one migration with every table they need, and the rules in `app/` that more than one of them reads. It builds no feature page.

Two questions the owner settled on 2026-11-11, recorded on their cards: approval is always on for now (TS-047), and an hour typed into a cell of the week's grid becomes one entry that starts when the day's last entry ends, or at 09:00 in the person's time zone when the day has none (TS-052).

- [ ] The destinations are Timesheet, Projects, Clients, Team, Approvals, Reports and Workspace settings, under the headings Track, Organize and Review or under none, each shown to the roles `docs/navigation.md` names. Clients is also hidden when the organisation turns Clients off. A heading shows only when a link under it shows (test).
- [ ] A destination a person may not see answers 404 at its address and at every address below it, the same 404 as another organisation's (a test per role, beside `test/pages/isolation.test.ts`).
- [ ] The navigation has a place for the timer's control before its first link, which draws nothing until TS-051 fills it (test).
- [ ] Each destination's page has its heading and an empty state that says what will be there.
- [ ] Members and invitations are at `team/members` and `team/invitations`, and `settings/members` redirects to the first (test). The person's own name, colour scheme, signing out and leaving the organisation are on My account, `/app/<slug>/account`, which every role opens, because a member no longer opens Workspace settings.
- [ ] One migration creates `clients`, `projects`, `time_entries`, `periods`, `period_events`, `teams` and `team_members`, and adds `users.time_zone` and the organisation's `time_zone`, `week_starts_on` and `clients_enabled`. Every new table is in `tenantTables` (test).
- [ ] The rules the slices share are in `app/` with their tests: who may see which destination and whose time, a manager's scope being the members of the teams they manage; one running entry for a person in an organisation; a period's bounds from the week start and the time zone; a submitted or approved period locks its entries.
- [ ] `docs/architecture.md` and `docs/security.md` describe the new tables and who sees which destination.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass, the shell's browser tests pass, and `pnpm db:migrate:local` applies the migration.

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

- [ ] Team > This week lists, for one week with arrows to earlier ones, each person the viewer may see: hours logged against their expected hours from TS-042, whether a timer is running, and the period's submission status (test). _Not ticked. Met: hours, running timer, status, arrows (`test/pages/team.test.ts`, "shows each visible person's hours, running timer and status"; `e2e/people.spec.ts`). Left: expected hours wait for TS-042, out of scope._
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

Builder: an AI session on branch `ts-054-reports`, one of the four slices built on TS-053. In review: the pull request against `main`. This is where "administrators can look at their time" (the owner, 2026-11-11) is built, and the manager's reach that TS-038 names is the foundation's `timeScopeOf`. The brief for the heading features (2026-11-11) changed three things this card first said: the days are counted in the organisation's time zone, not the viewer's, so everyone who reads a report reads the same days; an entry that crosses midnight is cut there and counted on each day; and a running entry is counted up to the time of the request instead of being left out (decision 26, "Reports and exports"). The date range needed no decision 28: its two days are the browser's own date fields, which write no `style` attribute.

- [x] A report covers a chosen range of days, this week, last week, this month or a custom range of up to 366 days, in the organisation's time zone, grouped by project, client or day, with its total. The range, the grouping and the person travel in the address (`test/reports/report.test.ts`, "the report an address asks for" and "the days of a range"; `e2e/reports.spec.ts`, chosen and shown with the keyboard alone).
- [x] An entry is cut at each local midnight of the organisation's zone and counted on each day of the range it has time in; a running entry is counted up to now (`test/reports/report.test.ts`, "an entry in a report"; `test/pages/reports.test.ts`, "cuts an entry at midnight", "counts its days in the organisation's zone" and "counts a running entry up to now").
- [x] Report totals equal the sum of the underlying entries for the same range, in every grouping (property test over 60 seeded sets of entries in six zones, clock changes included: "a property of every report").
- [x] A member sees their own entries, a manager their own and their teams' people's, an owner or admin everyone's, and each may narrow the report to one person they may see. Naming anybody else is the 404 of another organisation (`test/pages/reports.test.ts`, "whose time a report holds", a test for each role).
- [x] The report contains only the caller's organisation ("holds nothing of another organisation"), and its two routes are in the cross-organisation 404 test (`test/pages/isolation.test.ts`).
- [x] The page works from the keyboard and has no WCAG 2.2 A or AA violation at 390 and 1280 px in either scheme, with entries and with none (`e2e/reports.spec.ts`).

### TS-014b · CSV export

Builder: the same session and branch as TS-014a. In review with it.

- [x] The export, at `reports/export` with the report's own query, has one row for each entry on each day of the range it has time in: the rows the page lists, so its durations add up to the page's total. Its columns, in this order: `entry_id`, `person`, `project`, `client`, `description`, `started_at`, `ended_at`, `duration_seconds`. Times are in UTC, in ISO 8601 with `Z`; a running entry's last row has no end (`test/reports/report.test.ts`, "a row of the CSV"; `test/pages/reports.test.ts`; `e2e/reports.spec.ts`, the download).
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
- [ ] The privacy notice names who runs Timesifier. _The owner's to supply: `CONTROLLER` in `app/routes/privacy.tsx`. Until then the notice says it is incomplete._
- [ ] `privacy@timesifier.com`, the address both notices give, receives mail and is read.

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

Open for the owner: in the month view, whether a week that crosses the end of the month shows the whole week's total or only its days in that month (proposed: only its days in the month, so that the weeks add up to the month).

- [ ] The month view shows one calendar month in the person's time zone: a total for each day, each week from Monday, each project, and one for the month (test).
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

### TS-040 · Leave

Depends on: TS-038.

No routes or tables are written here yet. When this card comes up it gets them, a role table and a goldfish review (`docs/ways-of-working.md`), like the cards in Ready.

Open for the owner: the kinds of leave, and whether leave is counted in days, half days or hours; and who decides a request from a person who is in no team, or who is the only owner.

- [ ] A person can ask for time off from a first day to a last day, in their time zone. A last day before the first is refused (test).
- [ ] A request waits until a manager of a team the person is in, an owner or an admin approves or refuses it. A member who manages none of the person's teams cannot decide it (a test for every cell of this card's role table).
- [ ] A request that has been approved or refused cannot be decided a second time (test).
- [ ] Approved leave is shown beside worked time in the person's day and week views, and no total of worked time includes it (test).
- [ ] A person sees their own requests, a manager their team's, an owner or admin everyone's, and a member nobody else's (a test for every cell).
- [ ] A request of one organisation is never shown or decided in another (test).

### TS-041 · The team calendar

Depends on: TS-040 and TS-013. It does not need TS-016: events read from an outside calendar are that card's.

No routes or tables are written here yet. When this card comes up it gets them, a role table and a goldfish review (`docs/ways-of-working.md`), like the cards in Ready.

Open for the owner: whether a member sees when the others in their team are on leave, or only the manager does.

- [ ] A person's calendar shows, for a chosen week or month in their time zone, their tracked entries and their approved leave, each on the local day it belongs to (test).
- [ ] A team's calendar shows the same for every member of the team, to a manager of that team and to an owner or admin (a test for every cell of this card's role table).
- [ ] A manager's calendar shows nobody from a team they do not manage (test with two teams).
- [ ] The hours shown for a person's day on the calendar equal that day's total in their week view (property test).
- [ ] The calendar can be moved through with the keyboard alone, and axe with WCAG 2.2 AA tags reports no violations (browser test).

### TS-042 · Policies

Depends on: TS-040.

No routes or tables are written here yet. When this card comes up it gets them, a role table and a goldfish review (`docs/ways-of-working.md`), like the cards in Ready.

Open for the owner: how leave accrues (a fixed number of days a year, or earned month by month); and whether a policy is one for the organisation or may differ by team.

- [ ] An owner or admin sets the organisation's working week: the days worked and the hours in each. A manager or a member cannot (a test for every cell of this card's role table).
- [ ] An owner or admin sets how leave accrues. For random policies and requests, a person's balance on any day equals what has accrued by that day less the approved leave taken (property test).
- [ ] The policy says which requests for leave need approval. A request that needs none is approved when it is made, and one that needs it waits (test).
- [ ] A change to a policy applies from the day it is made, and no request already decided changes (test).
- [ ] The policy of one organisation is never read or changed from another (test).

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
