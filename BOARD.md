# Board

How the board works, and what Ready and Done mean, is in `docs/ways-of-working.md`. The columns are listed nearest to done first. Only the integrator edits this file; a criterion is ticked only with its evidence beside it.

**The path.** The next three cards are TS-011a, TS-012a and TS-013, in that order. No card outside this path is pulled until a person can sign up, run a timer and see it in the week view in production. Three things come first and are named here so that nobody has to guess: the cards already in flight below finish; TS-022a is Done before TS-012a is pulled, because that is when the first data worth recovering arrives; and TS-032 is Done before TS-030 is deployed, because sign-up stays open to the public.

## In progress (limit 1 per builder)

### TS-009 · Organisations and roles

Builder: an AI session on branch `ts-009-pages` (pull request #20). Built in two passes, like TS-008. The first, the server, is merged: the organisations, invitations and roles behind Better Auth's organization plugin, with one gate in front of every organisation endpoint. The second adds the pages under `/app/<organisation>/…` and the invitation page, once the shell (TS-006) and the sign-in pages (TS-008) are in. Teams are not built: no criterion asks for them.

- [ ] A signed-in person can create an organisation and becomes its owner. _Server side proven in `test/organisations/create.test.ts`: "makes the signed-in person its only member, with the role owner"; refused without a session (401) and for an unverified address (403); the slug is derived on the server, is never a reserved word, and gets a number when taken. Still to do: the page._
- [ ] An invitation link works once, expires after 7 days, and a test shows a used or expired link is rejected. _Server side proven in `test/organisations/invitations.test.ts`: "is accepted once, and makes its recipient a member as it said" (the second attempt is refused and adds no membership); "works for exactly seven days" (accepted one second before, refused one second after); refused when cancelled, declined, or opened by a person with another address; and "answers the same whether it is unknown, used, cancelled, expired or somebody else's". Still to do: the link's own page._
- [x] Roles are owner, admin and member. A table in this card lists which role may do what, and a test covers every cell. _The table is below. `test/organisations/permissions.test.ts`: "has 27 cells, each with a trial, and no trial contradicts its cell", with 43 trials through the real endpoints, each asserting the status and what is stored. With a member wrongly allowed to invite, the test fails. The last-owner rule has six tests of its own, and a person who is not a member gets, for each of 15 attempts, the answer given about an organisation that does not exist._
- [ ] A member of one organisation receives 404 for any URL of another organisation (test). _The function the pages will call, `requireMembership`, is proven in `test/organisations/membership.test.ts`: "says the same 'not found' for somebody else's organisation as for one that does not exist". Still to do: the routes, and the test that walks every one of them._

| Action                                               | owner                      | admin                | member |
| ---------------------------------------------------- | -------------------------- | -------------------- | ------ |
| See the organisation and its members                 | yes                        | yes                  | yes    |
| Rename the organisation                              | yes                        | yes                  | no     |
| Delete the organisation                              | yes                        | no                   | no     |
| Invite a person                                      | yes                        | yes                  | no     |
| Cancel an invitation                                 | yes                        | yes                  | no     |
| Change a member's role between admin and member      | yes                        | yes                  | no     |
| Make another person owner, or change an owner's role | yes                        | no                   | no     |
| Remove a member                                      | yes                        | yes, except an owner | no     |
| Leave the organisation                               | yes, unless the last owner | yes                  | yes    |

An organisation always has at least one owner: the last owner cannot leave, be removed or be demoted.

### TS-029 · Remove passkeys: the emailed code is the one way in

Builder: an AI session on branch `ts-029-remove-passkeys`. The owner decided on 2026-11-11 that a person signs up and signs in with the emailed code and nothing else. The evidence for each criterion is ticked in this card's pull request.

- [ ] `/sign-in` opens on the email address, `/sign-up` ends when the code is accepted, and Settings has no Passkeys section (browser tests).
- [ ] The passkey plugin and the dependency `@better-auth/passkey` are gone, and the six passkey endpoints are off the list in `app/auth/endpoints.ts`; `test/auth/endpoints.test.ts` holds the new count (test).
- [ ] `Permissions-Policy` denies `publickey-credentials-get` and `publickey-credentials-create` (test).
- [ ] The change ships in two merges. The first removes the plugin, the pages and the tests and leaves the `passkeys` table in `app/db/schema.ts`. The second changes only `migrations/` and `app/db/schema.ts` and drops the table. The pipeline's `migration check` job passes on both.
- [ ] Somebody who knows a person's address cannot use up that person's codes. The cap of five codes an hour for an address is counted in two buckets: one for browsers that have signed in as that address before, one for everybody else. After five requests from a browser that never signed in as the address, a browser that did is still sent a code (test).
- [ ] The decision is an entry in `docs/decisions.md` that amends entries 8 and 22 and describes the two buckets. What stays open, a first sign-in on a new browser, is a row in `docs/security.md`, "Known gaps and accepted risks".
- [ ] How a person signs in is described once, in `docs/security.md`, "Flows". `docs/architecture.md`, `docs/product.md` and `README.md` name it and link there.
- [ ] Deployed, and the owner has signed in at `https://timesifier.com` with a code.

### TS-030 · A home page, a privacy page, a terms page, and the visual direction

Builder: an AI session on branch `ts-030-landing`. The owner's verdict on what was first deployed: it works, but it does not look like a designed product. This card writes the direction the product follows in `docs/design-direction.md`, changes the tokens to carry it, and replaces the three-line home page. It also takes the home-page criterion that TS-025 held. Because sign-up stays open to the public (the owner, 2026-11-11), the privacy page and the terms page ship with it. The evidence for each criterion is ticked in this card's pull request.

- [ ] The direction is written down before anything is built: who the product is for, the feeling, the typefaces, the palette, how imagery is used, three things the design refuses to do, and the shipped products it was checked against. It is in `docs/design-direction.md`, and an entry in `docs/decisions.md` replaces entries 4 and 16 with what stays, what goes and what is undecided. The entry takes the next free number: TS-029 holds 23.
- [ ] The owner has approved the direction. TS-011a waits for this.
- [ ] The tokens carry the direction and still come from one seed. Every text role is at least 4.5:1 on its background in both schemes (test).
- [ ] `/` says what Timesifier does for a person, offers one primary action, "Create an account", with "Sign in" beside it, and shows the product before any scrolling at 390px and 1280px (browser test).
- [ ] The page shows nothing the product will not do, and every total on it is the sum of what is shown above it (test).
- [ ] The page is server rendered and works without script (browser test).
- [ ] No accessibility violation at 390px and 1280px in the light and the dark scheme; the keyboard reaches the primary action, which shows its focus (browser test).
- [ ] Every photograph is our own file with its size, a description and its source on record, and nothing moves when one arrives (tests).
- [ ] The components still pass their own tests on the new tokens.
- [ ] `/privacy` and `/terms` exist and are server rendered. The privacy page says what is stored about a person, why, that it rests in the EU, for how long, and how to have an account deleted before TS-021a is built. A test finds a link to each on `/`, `/sign-in` and `/sign-up`.
- [ ] From TS-006: in the rail the travelling indicator no longer passes over the labels between two destinations; the skip link, while focused, no longer covers the top of the rail; the radio rings in Settings line up with the headings above them. Each has a browser test or a screenshot the owner has accepted.
- [ ] Deployed after TS-032, and seen by the owner at `https://timesifier.com`.

### TS-031 · Apply the review of the plan

Builder: an AI session on branch `ts-031-plan`. Six reviewers went over the architecture, the design flow and the way of working. This card applies what they found to the documents, the board and the pipeline. It changes no application code.

- [ ] TS-011a, TS-012a and TS-013 are in Ready, each with its routes, tables and columns, a role table and criteria a test can decide.
- [ ] `docs/ways-of-working.md` holds one procedure for a card, with each step given to the builder or the integrator.
- [ ] Decisions 25 (time entries) and 26 (time zone) are written in `docs/decisions.md`.
- [ ] The browser tests run in a job of their own, `browser tests`, beside `checks`; `preview` and `deploy` need both. The integrator adds `browser tests` to the checks `main` requires, in the same hour as the merge.
- [ ] A pull request whose new migration holds `DROP` or `RENAME` fails the job `migration check` unless it changes only `migrations/` and `app/db/schema.ts`.
- [ ] Done cards are in `docs/board-done.md`, and the board keeps one line for each.
- [ ] `pnpm format` and `pnpm lint` exit 0.

## Review (limit 2; a card waiting only on the owner is not counted)

### TS-008 · Authentication

Built in two passes. The server, then the pages: the sign-in and sign-up pages, passkeys in a browser and the guard on `/app` (pull request #17). In Review, waiting only on the owner: one real message received in production. Turnstile refuses an automated browser, as it should, so the first sign-up is the owner's to make.

2026-11-11: the passkey parts of the second and fourth criteria describe what was built and are superseded by TS-029, which removes passkeys (its decision entry in `docs/decisions.md` arrives with that card).

- [x] The supported way to run Better Auth on D1 is confirmed against its documentation and written in `docs/decisions.md` entry 8. _The Drizzle adapter over `drizzle-orm/d1`, one of the two routes the documentation gives. `test/auth/schema.test.ts`: "pass Better Auth's own schema check; rename a property there and this fails". Every test in `test/auth/` drives the Worker against a local D1 built from `migrations/`. Built on `better-auth` 1.7.19._
- [x] A person can sign up and sign in with a passkey and with email, sign out, and end all their sessions; each has a test. _In a browser, against the production build, with a virtual authenticator (`e2e/auth-journeys.spec.ts`): "with an email code makes the account, and a passkey is made straight after"; "sign out ends the session; the passkey alone signs back in"; "an email code signs in, and goes on to the page that was asked for"; "ends the session in a second browser too". What the pages say when the answer is no is in `e2e/auth-refusals.spec.ts`. On the server: `test/auth/email-code.test.ts`, `test/auth/passkey.test.ts` and `test/auth/session.test.ts`._
- [x] The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax` and uses the `__Host-` prefix (test reads the `Set-Cookie` header). _`test/auth/session.test.ts`, the test of the cookie's attributes, prefix, path and absent domain. The header sent: `__Host-timesifier.session_token=…; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`. With the three cookie options removed the test fails: the library's default is not even `Secure`._
- [x] The 11th sign-in attempt in one minute from one client returns status 429 (test). _`test/auth/rate-limit.test.ts`: "the 11th attempt in a minute from one client is answered 429, the first ten are not", for email-code sign-in and passkey sign-in. The minute is measured from the last attempt that was let through. Asking for a code is held tighter since TS-027: the 4th request in a minute is answered 429._
- [x] Sign-up without a valid Turnstile token is rejected by the server (test with Turnstile's test keys). _`test/auth/turnstile.test.ts`, against Cloudflare's real `siteverify`: the always-pass key gives 200; the always-fail key gives 403; a missing token gives 400; neither refusal creates or sends a code. The check guards the request for a code, which is the only way into sign-up._
- [x] A test lists every route under `/app` and shows each redirects to sign-in without a session. _`test/auth/guard.test.ts` reads the routes from the built route configuration, so a route added under `/app` is tested without anyone listing it: "without a session, every route under /app redirects to sign-in", for each route's page (302 to `/sign-in?next=…`), its data request (202 carrying the same redirect) and a posted form where the route has an action. In production on 2026-11-11: `/app`, `/app/settings` and `/app/reports?week=46` each answered 302 to `/sign-in` with the address in `next`._
- [ ] Verification email is sent from a dedicated subdomain; the zone comparison from TS-003 shows no other record changed. _The subdomain is `mail.timesifier.com`, onboarded to Cloudflare Email Service on 2026-11-11 at 03:03 UTC: the zone went from 29 records to 35, the six new ones all under `mail.timesifier.com` (three MX and an SPF record at `cf-bounce.mail`, DKIM at `cf-bounce._domainkey.mail`, DMARC at `_dmarc.mail`), and no other record changed; the zone's public answers were compared again after the pages went live and differ from the first capture by those six alone. `test/auth/email.test.ts`: "comes from no-reply@mail.timesifier.com and carries the code once". Still to do: one real message received, which takes a person (see above)._

### TS-028 · A text field's label covers what a person types, in Safari

Found on 2026-11-11 while checking the live sign-up page in a WebKit browser: the label of a field stayed on the line the person was typing on. Chromium was right, and every component test ran in Chromium. The cause is a defect in WebKit 27.2, reduced to a five-line page in `docs/design-system.md`, "State from another element": it does not restyle a text input's siblings for an attribute written during an event, which is when React Aria writes `data-focused` and `data-hovered`.

- [x] A test fails for this reason before the fix, in WebKit. _`e2e/field-label.spec.ts` in WebKit 27.2, before the fix: on the sign-up page the label still reached 16px into the value's line after focus; in the gallery the line under a field stayed 2px after focus had left, and the label of a field left empty did not come back down. The same tests passed in Chromium._
- [x] The label and the line of a text field and of a select follow focus, typing, a value that arrives without focus, and leaving, in Chromium and in WebKit. _The six tests of `e2e/field-label.spec.ts` pass in both engines. The label and the line now read the control's state through their container (`group-has-data-focused/field:`), which WebKit follows._
- [x] The pattern cannot come back unseen. _`pnpm check:tokens` rejects a style read from a sibling's attribute (`scripts/check-tokens.test.ts`: `peer-data-focused:` and `peer-not-aria-invalid/field:` are reported; state from the element, an ancestor, `:has()` or a sibling's pseudo-class passes). The component tests, 44 with these, now run in WebKit as well as Chromium on every pull request._
- [ ] Seen right in production in a WebKit browser.

## Ready (limit 3)

The next cards, in the order they are pulled. A card is pulled only when every card on its "Depends on" line is Done.

What holds for all three, from `app/db/schema.ts`: an id is a UUID version 7 stored as text; a time is an integer of milliseconds since the Unix epoch, in UTC; a table with an `organisation_id` is added to `tenantTables` and reached only through `organisationScope`. The organisation's slug is the route parameter `organisation`, so the addresses below are written `/app/:organisation/…`. The integrator gives each card its migration number before work starts.

### TS-011a · Projects

**Depends on:** TS-009 (the pages, pull request #20); TS-030's criterion that the owner has approved the direction. Decision 25 is written.

**Reference for the screen:** `docs/design-direction.md`, which arrives with TS-030, and the members page of TS-009 as the nearest page already built: a list, with a sheet for quick editing.

**Owns:** `app/routes/app/projects.tsx`, a new folder `app/projects/`, one migration, the `projects` table in `app/db/schema.ts` and its line in `tenantTables`, and the tests of this page.

**Interfaces:** a function in `app/projects/` that returns the active projects of an organisation, by name. TS-012a's timer reads it.

**Routes:** `/app/:organisation/projects`, module `routes/app/projects.tsx`, the existing Projects destination. Its loader lists the projects. Its action takes the intents `create`, `rename`, `archive` and `restore`. No new address.

**Tables:** `projects`

| Column                     | Type and constraint                                                             |
| -------------------------- | ------------------------------------------------------------------------------- |
| `id`                       | text, primary key                                                               |
| `organisation_id`          | text, not null, references `organisations.id`, cascade on delete                |
| `name`                     | text, not null, 1 to 120 characters after trimming                              |
| `name_key`                 | text, not null: `name` normalised (NFKC), trimmed and lower-cased in the Worker |
| `archived_at`              | integer, null while the project is active                                       |
| `created_at`, `updated_at` | integer, not null                                                               |

A unique index on `(organisation_id, name_key)`. It covers archived projects, so a restore can never clash. There is no client column: TS-011b adds a nullable `client_id`.

**Who may** (the owner, 2026-11-11: every role manages projects)

| Action                                               | owner | admin | member |
| ---------------------------------------------------- | ----- | ----- | ------ |
| See the organisation's projects, active and archived | yes   | yes   | yes    |
| Create a project                                     | yes   | yes   | yes    |
| Rename a project                                     | yes   | yes   | yes    |
| Archive or restore a project                         | yes   | yes   | yes    |
| Delete a project                                     | no    | no    | no     |

**Acceptance criteria**

- [ ] A migration creates `projects` as above, and `projects` is in `tenantTables` (test: the scope of one organisation returns none of another's rows).
- [ ] `create` with a name of 1 to 120 characters after trimming stores one row and the list shows it. An empty name, a name of spaces and a name of 121 characters each answer 400 with the text "Enter a name of up to 120 characters." and store nothing (test).
- [ ] A name is unique in its organisation ignoring case, archived projects included. After "Design", `create` "design" answers 400 with "A project with this name already exists." and stores nothing. The same name in another organisation is accepted (test).
- [ ] `rename` obeys both rules, and renaming "Design" to "DESIGN" is accepted (test).
- [ ] `archive` sets `archived_at`. The project leaves the default list and the function the timer reads, and appears under a filter named "Archived". `restore` clears `archived_at` (test).
- [ ] The action answers 400 to any intent other than the four, and no request removes a `projects` row (test).
- [ ] Every cell of the "Who may" table has a test through the real action.
- [ ] A member of organisation A receives 404 for `/app/<slug of B>/projects`, and 404 with nothing changed for an action that names a project of B. The route and its action are in `test/pages/isolation.test.ts`, the cross-organisation 404 test that TS-009's pages add (test).
- [ ] A new organisation has no projects (test).
- [ ] With no projects the page shows a heading "No projects yet", the sentence "A project is what you track time against, such as a client job or a piece of your own work.", and exactly one button, named "Create project" (test).
- [ ] A project can be created, renamed and archived with the keyboard alone (browser test).
- [ ] axe with WCAG 2.2 AA tags reports no violations on the page, empty and filled, in both schemes (browser test).
- [ ] The pull request shows the page at 390px and 1280px in both schemes, and the owner has accepted the screenshots.

### TS-012a · Timer

**Depends on:** TS-011a; TS-022a. Decisions 25 and 26 are written.

**Reference for the screen:** `docs/design-direction.md`, and the timer shown on the home page of TS-030.

**Owns:** `app/routes/app/today.tsx`, a new folder `app/time/`, one migration, `time_entries` and `users.time_zone` in `app/db/schema.ts`, the `batch` method in `app/db/scope.ts`, and the tests of the timer.

**Interfaces:** reads the active projects through TS-011a's function. TS-013 reads `time_entries` and `users.time_zone` and builds on the same route module.

**Routes**

- `/app/:organisation`, module `routes/app/today.tsx`, the existing Today destination. Its action takes the intents `start` and `stop`.
- `/app/:organisation/settings`, module `routes/app/settings.tsx`. Its action gains the intent `time-zone`.
- `/sign-up` sends the zone the browser reports along with the code.

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
- [ ] An account made on `/sign-up` is stored with the zone the browser reported. A signed-in person whose `time_zone` is null has it set the next time they open Today, from the zone their browser reports. A name that is neither `UTC` nor known to `Intl` is not stored (test).
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
- [ ] `stop` takes no entry id. An action sent to an organisation the caller is not in answers 404 and changes nothing, and both intents are in `test/pages/isolation.test.ts` (test).
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
- [ ] A member of organisation A receives 404 for both pages of organisation B, and `/app/:organisation/week` is in `test/pages/isolation.test.ts` (test).
- [ ] The query behind each page uses the index `(organisation_id, user_id, started_at)`: `EXPLAIN QUERY PLAN` names it (test).
- [ ] With no entries in the day, the list shows the sentence "Nothing tracked on this day." and adds no button: the timer's is the page's one primary action (test).
- [ ] One browser test starts from an address never seen before and does only this: fills in the sign-up form, enters the code, names an organisation, creates one project, presses "Start timer" and opens Week. It finds the running entry in today's column. The test has a time limit of 120 seconds for all of it, so it fails when the steps take longer. This is the criterion for "under two minutes" in `docs/product.md`.
- [ ] axe with WCAG 2.2 AA tags reports no violations on either page, empty and filled, in both schemes (browser test).
- [ ] The pull request shows both pages at 390px and 1280px in both schemes, and the owner has accepted the screenshots.

Moved out of this card: "an entry can be added from the keyboard alone" is on TS-012b, where entries are added by hand.

## Backlog

In priority order. Before a feature card enters Ready it gains "Routes", "Tables" and "Who may" sections like the three cards above, and the criterion that every new route joins the cross-organisation 404 test of TS-009.

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

### TS-032 · A ceiling on the email the application sends

Depends on: nothing. Done before TS-030 is deployed: sign-up is open to the public, and today nothing bounds the total number of messages.

- [ ] One client address is sent at most a fixed number of sign-in codes a day, whatever addresses it names; the next request is answered like a served one and nothing is sent (test). The number is written in `docs/architecture.md`.
- [ ] The application sends at most a fixed number of messages a day in all, set below the Email Service quota; above it nothing is sent and one line is logged (test). The number is written in `docs/architecture.md`.
- [ ] Both counts are kept under a keyed hash or a fixed name, never an address (test).

### TS-021a · Account deletion

Depends on: TS-012a. Moved ahead of reports by the owner on 2026-11-11, because sign-up is public.

- [ ] A signed-in person can delete their account from Settings. The confirmation is a sheet in which they type the account's email address.
- [ ] Deleting an account ends every session of the person and removes their memberships, and the invitations they sent.
- [ ] Time entries keep their `user_id`. The `users` row stays; its name becomes "Deleted person" and its address becomes a value that identifies nobody and can receive no mail. A test lists every table with a column that refers to a person and checks each; it fails when a table is added and not listed.
- [ ] The last owner of an organisation with other members must hand it over first; the sheet says so and nothing is deleted (test).
- [ ] The privacy page says how to delete an account, in the words of the Settings page.

### TS-011b · Clients

Depends on: TS-011a.

- [ ] A table `clients` (the columns of `projects`, with the same name rules) and a nullable `client_id` on `projects`.
- [ ] Every role can create, rename and archive a client, and give a project a client or none (a test for every cell, as TS-011a).
- [ ] Names are required, at most 120 characters, and unique within the organisation ignoring case (tests).
- [ ] An archived client is not offered when a project is edited, and its projects keep it.

### TS-012b · Manual entries

Depends on: TS-013.

Not Ready. One decision is open, and it is the owner's: whether `style` attributes stay banned by the Content Security Policy. React Aria's date and time components write them. Either the policy gains `style-src-attr 'unsafe-inline'` and the components are used as shipped, or the ban stays and this card builds date and time fields on React Aria's hooks. The answer becomes decision 28 before this card enters Ready. TS-014a's date range waits on the same answer.

- [ ] A person can add, edit and delete their own entries by hand; an end before its start is rejected (test).
- [ ] An owner or admin can see another member's entries and cannot change them (a test for every cell of this card's role table).
- [ ] An entry can be added from the keyboard alone, without the pointer (browser test).
- [ ] A day and a time typed by a person are read in the person's time zone (decision 26); a time that does not exist on that day, in the hour a clock change skips, is rejected (test).

### TS-014a · Reports

Depends on: TS-013. The date range waits on the same decision as TS-012b.

- [ ] A report covers a chosen range of days in the viewer's time zone, grouped by project, client or day.
- [ ] An entry is counted in the local day it starts in, and a running entry is left out (test).
- [ ] Report totals equal the sum of the underlying entries for the same range (property test).
- [ ] A member sees their own entries. An owner or admin can also see every member's, and a report for one member (a test for every cell of this card's role table).
- [ ] The report contains only the caller's organisation (test), and its route is in the cross-organisation 404 test.

### TS-014b · CSV export

Depends on: TS-014a.

- [ ] The export of a report has one row for each entry and these columns in this order: `entry_id`, `person`, `project`, `client`, `description`, `started_at`, `ended_at`, `duration_seconds`. Times are in UTC, in ISO 8601 with `Z`.
- [ ] The file parses back to the same values with an RFC 4180 parser (property test over descriptions with commas, quotes and line breaks).
- [ ] A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` (test).
- [ ] The response is streamed in pages keyed on `id`, and nothing is stored (test with more entries than one page).
- [ ] A member exports their own entries; an owner or admin exports every member's (test). The export contains only the caller's organisation (test).

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

- [ ] A person can plan a focus block on a day; it appears in Today and Week.
- [ ] A block that overlaps a calendar event shows the text "This block overlaps" followed by the event's title before it is saved, and it can still be saved (test).
- [ ] At the end of the day the view shows planned focus time beside the time actually tracked during those blocks; the two figures are covered by a test.

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
