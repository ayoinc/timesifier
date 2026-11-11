# Board

How the board works, and what Ready and Done mean, is in `docs/ways-of-working.md`. Tick a criterion only with its evidence beside it.

## In progress (limit 1 per worker)

### TS-008 · Authentication

Built in two passes. The server, then the pages: the sign-in and sign-up pages, passkeys in a browser and the guard on `/app` (pull request #17). One thing is left before Done: one real message received in production. Cloudflare's Turnstile asks an automated browser to prove it is a person, as it should, so the first sign-up is the owner's to make.

- [x] The supported way to run Better Auth on D1 is confirmed against its documentation and written in `docs/decisions.md` entry 8. _The Drizzle adapter over `drizzle-orm/d1`, one of the two routes the documentation gives. `test/auth/schema.test.ts`: "pass Better Auth's own schema check; rename a property there and this fails". Every test in `test/auth/` drives the Worker against a local D1 built from `migrations/`. Built on `better-auth` 1.7.19._
- [x] A person can sign up and sign in with a passkey and with email, sign out, and end all their sessions; each has a test. _In a browser, against the production build, with a virtual authenticator (`e2e/auth-journeys.spec.ts`): "with an email code makes the account, and a passkey is made straight after"; "sign out ends the session; the passkey alone signs back in"; "an email code signs in, and goes on to the page that was asked for"; "ends the session in a second browser too". What the pages say when the answer is no is in `e2e/auth-refusals.spec.ts`. On the server: `test/auth/email-code.test.ts`, `test/auth/passkey.test.ts` and `test/auth/session.test.ts`._
- [x] The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax` and uses the `__Host-` prefix (test reads the `Set-Cookie` header). _`test/auth/session.test.ts`, the test of the cookie's attributes, prefix, path and absent domain. The header sent: `__Host-timesifier.session_token=…; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`. With the three cookie options removed the test fails: the library's default is not even `Secure`._
- [x] The 11th sign-in attempt in one minute from one client returns status 429 (test). _`test/auth/rate-limit.test.ts`: "the 11th attempt in a minute from one client is answered 429, the first ten are not", for email-code sign-in and passkey sign-in. The minute is measured from the last attempt that was let through. Asking for a code is held tighter since TS-027: the 4th request in a minute is answered 429._
- [x] Sign-up without a valid Turnstile token is rejected by the server (test with Turnstile's test keys). _`test/auth/turnstile.test.ts`, against Cloudflare's real `siteverify`: the always-pass key gives 200; the always-fail key gives 403; a missing token gives 400; neither refusal creates or sends a code. The check guards the request for a code, which is the only way into sign-up._
- [x] A test lists every route under `/app` and shows each redirects to sign-in without a session. _`test/auth/guard.test.ts` reads the routes from the built route configuration, so a route added under `/app` is tested without anyone listing it: "without a session, every route under /app redirects to sign-in", for each route's page (302 to `/sign-in?next=…`), its data request (202 carrying the same redirect) and a posted form where the route has an action. In production on 2026-11-11: `/app`, `/app/settings` and `/app/reports?week=46` each answered 302 to `/sign-in` with the address in `next`._
- [ ] Verification email is sent from a dedicated subdomain; the zone comparison from TS-003 shows no other record changed. _The subdomain is `mail.timesifier.com`, onboarded to Cloudflare Email Service on 2026-11-11 at 03:03 UTC: the zone went from 29 records to 35, the six new ones all under `mail.timesifier.com` (three MX and an SPF record at `cf-bounce.mail`, DKIM at `cf-bounce._domainkey.mail`, DMARC at `_dmarc.mail`), and no other record changed; the zone's public answers were compared again after the pages went live and differ from the first capture by those six alone. `test/auth/email.test.ts`: "comes from no-reply@mail.timesifier.com and carries the code once". Still to do: one real message received, which takes a person (see above)._

### TS-009 · Organisations, teams and roles

Built in two passes, like TS-008. The first, the server, is merged: the organisations, invitations and roles behind Better Auth's organization plugin, with one gate in front of every organisation endpoint. The second adds the pages under `/app/<organisation>/…` and the invitation page, once the shell (TS-006) and the sign-in pages (TS-008) are in. Teams are not built: no criterion asks for them.

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

### TS-030 · A home page, and the visual direction

The owner's verdict on the first release: it works, but it does not look like a designed product. This card is the first visible step: the direction the product follows, the tokens that carry it, and a real home page in place of three lines of text. Built on branch `ts-030-landing`; not yet deployed.

- [x] The direction is written down before anything is built: who the product is for, the feeling, the typefaces, the palette, how imagery is used, three things the design refuses to do, and the shipped products it was checked against. _`docs/design-direction.md`. Decision 23 replaces decision 16._
- [x] The tokens carry the direction and still come from one seed: `#FFD400` in the fidelity scheme, Sofia Sans in two widths, corners of 2 to 24px. Every text role is at least 4.5:1 on its background in both schemes. _`scripts/tokens.test.ts`, "colour roles": 101 cases pass, with `primary` on every surface and the sheet's pairs added. The fonts are files under the SIL Open Font License 1.1 in `app/fonts/`, with `OFL.txt`; `@fontsource-variable/roboto-flex` is removed._
- [x] `/` says what Timesifier does for a person, offers one primary action, "Create an account", with "Sign in" beside it, and shows the product above the fold. _`e2e/landing.spec.ts`, at 390px and 1280px in both schemes: "the primary action and the product are on show before any scrolling, and nothing runs off the side"; "Sign in, beside the primary action, opens the sign-in page"._
- [x] Four sections each make one point (track, the week, accuracy, privacy), then a closing action and a footer. The page shows nothing the product will not do, and every total on it is the sum of what is shown above it. _The example is `app/landing/example-week.ts`. `test/landing-example.test.ts`: "the day's entries are what the week shows for that day, project by project"; "the week's total is the sum of its rows and of its columns"._
- [x] The page is server rendered and works without script. _`e2e/landing.spec.ts`, "without script": "the page is all there, and its primary action still opens sign-up"._
- [x] No accessibility violation at 390px and 1280px, in the light and the dark scheme; the keyboard reaches the primary action, which shows its focus. _`e2e/landing.spec.ts`: "the home page has no accessibility violations" (four cases); "the keyboard reaches the primary action, which shows where the focus is and opens sign-up"; "the skip link moves the focus into the main region". Each also runs in WebKit._
- [x] Every photograph is our own file, in AVIF and WebP, with its size, a description and its source on record; nothing moves when one arrives. _Four photographs under the Unsplash licence, 20 files, 1.0 MB in all, in `public/images/` with `CREDITS.md`. `test/node/landing-images.test.ts`: "every file the page asks for exists, and no other image is served"; "every file is in the credits, with its author, its source page and the licence". `e2e/landing.spec.ts`: "every image has its size, a description, and comes from our own host"; "nothing on the page moves when its images arrive", which first failed on a one-pixel difference between two widths of one photograph._
- [x] The components still pass their own tests on the new tokens. _`pnpm test:e2e`: every earlier browser test passes. Two things changed for it: `on-secondary-container` is placed on a darker role, because Material's fell to 4.02:1 under a pressed state layer on a tonal button; and a selected switch keeps its handle's colour, which was the track's in the dark scheme._
- [ ] Deployed, and seen by the owner at `https://timesifier.com`.

## Review (limit 2)

### TS-002 · Pipeline: checks on every pull request

Blocked on one criterion; the rest is merged.

- [x] A workflow runs on every pull request and on `main`: install with a frozen lockfile, typecheck, lint, tests, build. _Pull request #2: job `checks` passed in 46 s._
- [x] A secret scan and `pnpm audit --audit-level=high` run in the workflow, and a finding fails it. _Job `secret scan` passed; the audit is the last step of `checks`. The audit was shown failing on a real finding on 2026-11-11: with the gate at moderate it exited 1 on advisory GHSA-67mh-4wv8-2f99 (`esbuild` 0.18, under `drizzle-kit`), and 0 once an override removed that version. The gate has been moderate and above since then. The secret scan has not been shown failing._
- [x] Every third-party action is pinned to a full commit SHA, and the workflow's default `permissions` are `contents: read`. _See `.github/workflows/ci.yml`._
- [x] A throwaway pull request with a failing test shows a failed check; it is then closed. _Pull request #3: `checks` failed in 35 s; closed and its branch deleted._
- [ ] `main` is protected: the check must pass before merging. _Blocked: GitHub answered "Upgrade to GitHub Pro or make this repository public to enable this feature." The owner decides. Until then, TS-003 deploys only after `checks` passes in the same workflow run._

### TS-028 · A text field's label covers what a person types, in Safari

Found on 2026-11-11 while checking the live sign-up page in a WebKit browser: the label of a field stayed on the line the person was typing on. Chromium was right, and every component test ran in Chromium. The cause is a defect in WebKit 27.2, reduced to a five-line page in `docs/design-system.md`, "State from another element": it does not restyle a text input's siblings for an attribute written during an event, which is when React Aria writes `data-focused` and `data-hovered`.

- [x] A test fails for this reason before the fix, in WebKit. _`e2e/field-label.spec.ts` in WebKit 27.2, before the fix: on the sign-up page the label still reached 16px into the value's line after focus; in the gallery the line under a field stayed 2px after focus had left, and the label of a field left empty did not come back down. The same tests passed in Chromium._
- [x] The label and the line of a text field and of a select follow focus, typing, a value that arrives without focus, and leaving, in Chromium and in WebKit. _The six tests of `e2e/field-label.spec.ts` pass in both engines. The label and the line now read the control's state through their container (`group-has-data-focused/field:`), which WebKit follows._
- [x] The pattern cannot come back unseen. _`pnpm check:tokens` rejects a style read from a sibling's attribute (`scripts/check-tokens.test.ts`: `peer-data-focused:` and `peer-not-aria-invalid/field:` are reported; state from the element, an ancestor, `:has()` or a sibling's pseudo-class passes). The component tests, 44 with these, now run in WebKit as well as Chromium on every pull request._
- [ ] Seen right in production in a WebKit browser.

## Ready (limit 3)

_Empty._

## Backlog

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

From TS-027: an unexpected error is now logged as its name and the path, and nothing else. That keeps addresses and tokens out of the log, and it also keeps out what a person needs to find the fault. This card adds the stack without its message line, and the request id, to that line.

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

### TS-027 · Close the findings of the authentication security review

Done 2026-11-11. Pull request #18. An independent, read-only review of the authentication and organisation servers found four medium and seven low findings, none high, before any sign-in page was live. Each was reproduced by a failing test before it was fixed. What stays open is in `docs/security.md`, "Known gaps and accepted risks".

- [x] A sign-in code has eight digits. One address is sent at most five in any hour and one client may ask three times a minute; above the hourly cap the answer is the same and nothing is issued or sent. _`test/auth/email-code.test.ts`: "sends a code of eight digits, the length the sign-in page asks for"; "are five in an hour, whoever asks and however the address is written: the sixth request is answered like the first and nothing is issued or sent"; "are counted over any hour, not over hours by the clock". `test/auth/rate-limit.test.ts`: "asking for an email code: the 4th request in a minute from one client is answered 429, the first three are served"._
- [x] A code is accepted only in the browser that asked for it; a guess from anywhere else gets the wrong-code answer and uses up none of the three attempts. _`test/auth/email-code.test.ts`: "refuses a stranger's guesses with the answer a wrong code gets, and they use up none of the three attempts", and a forged, altered or empty cookie is refused "even with the right code". In a browser, `e2e/auth-refusals.spec.ts`: a code asked for in one browser and typed in another is refused, and then signs in the browser that asked. Decision 22._
- [x] An invitation cannot be read or accepted once the person who sent it may no longer invite. _`test/organisations/invitations.test.ts`, "an invitation whose sender may no longer invite": removed, demoted, left, and "cannot be accepted once the owner who sent it has handed the organisation over and become a member"; each answers the 404 every invalid invitation gets._
- [x] An invitation email cannot carry a stranger's text in its subject, one person sends at most twenty invitations in 24 hours, and owns at most five organisations. _`test/organisations/invitations.test.ts`: "has the same subject whatever the organisation is called: the name is in the body alone"; "are twenty in 24 hours across all their organisations: the 21st is refused, stores nothing and sends nothing". `test/organisations/create.test.ts`: "are five: the sixth is refused in words a page can show, and creates nothing"._
- [x] The application answers only the endpoints it offers: 26, on one list. Everything else the library registers is answered 404 before the database or the rate limit is touched. _`test/auth/endpoints.test.ts`: "are these 26 and no other"; "answers 404 for every other endpoint the installed library registers, before the database is touched", which reads the endpoints from the installed library, so an upgrade that adds one fails the test. The library registers 70 under this configuration._
- [x] Each environment trusts only its own hosts, and no answer sends the browser anywhere but a path on the same origin. _`test/auth/session.test.ts`, "hosts": production trusts `timesifier.com` alone, a preview its own `workers.dev` name, anything else `localhost`; "accepts a path on its own origin as a place to send the browser", and every other value of the four redirect fields is answered 403 with the library's code for that field._
- [x] A passkey is accepted only when the authenticator verified the person, and a credential id is stored once. _`test/auth/passkey.test.ts`, with a software authenticator running both ceremonies: "refuse to add a passkey when the authenticator did not verify the person"; "refuse a sign-in with a passkey when the authenticator did not verify the person"; "refuse a second passkey with the id of somebody's first as the caller's mistake, and the first goes on signing its owner in". Migration `0003_passkey_credential_unique.sql`._
- [x] An unexpected error is logged as its name and the path, with path parameters by name, and never its message, a parameter or a query string, inside authentication and outside it. _`test/error-log.test.ts`: "in a loader whose database statement fails: a plain 500 page, and the log has the error's name and the path alone"; "is logged without its message, the query string or the values in the path". Before the fix a failed statement put a session token in the log. The log lines about email say nothing about the recipient._
- [x] A sign-in code is stored as an HMAC under the application's secret, so a copy of the database alone does not give codes up. _`test/auth/email-code.test.ts`: "keeps the code in the database as a keyed hash: neither the code nor its plain SHA-256 is there"._
- [x] A Turnstile token solved on another site is refused. _`test/auth/turnstile.test.ts`, "the site a token was solved on", against Cloudflare's real `siteverify`; Cloudflare's test keys answer with one fixed hostname, which is accepted only while the configured secret is one of the published test secrets._
- [x] Deployed, and checked in production: an endpoint that is not offered answers 404, a request for a code without Turnstile's token is refused, a code without the browser's cookie is refused, and the pages load. _At `https://timesifier.com` on 2026-11-11 at 06:58 UTC: `/api/auth/ok`, `/error`, `/update-user`, `/sign-up/email` and `/organization/list-user-invitations` answered 404; asking for a code answered 400 `MISSING_RESPONSE` without a token and 403 `VERIFICATION_FAILED` with a made-up one; using a code without the cookie answered 400 `INVALID_OTP`; signing out with a `callbackURL` on another site answered 403 `INVALID_CALLBACK_URL`; `/sign-in` and `/sign-up` answered 200 and `/app` 302 to sign-in. A whole sign-in in production takes a person, and is the last step of TS-008._

### TS-006 · Application shell

Done 2026-11-11. Pull request #16.

- [x] Below 600px the shell shows a navigation bar; from 600px it shows a navigation rail with the same destinations. _`e2e/shell-navigation.spec.ts`: "in a window 390px wide › the navigation is a bar along the bottom with the four destinations"; "in a window 1280px wide › the navigation is a rail down the side with the same four destinations"; "the bar becomes the rail at 600px, and back, without the page loading again"; and without script the server's one navigation is right at both widths. One `nav` element, drawn either way by CSS._
- [x] Moving between destinations animates in the direction of travel using view transitions; with reduced motion requested there is no movement. _`e2e/shell-transitions.spec.ts`, at both widths: "the content moves across, one way going forward and the other way going back" (up and down in the rail); "the navigation stays still and its active indicator travels as one element"; "a second press during a transition interrupts it"; "with reduced motion requested › a change of destination fades and nothing moves". Removing the interrupt and the reduced-motion rule makes exactly those tests fail._
- [x] The page has a skip link and landmarks, and after navigation focus is on the main heading (test). _`e2e/shell-navigation.spec.ts`, at both widths: "the first Tab reaches a skip link, and Enter moves the focus into the main region"; "the page has one navigation landmark with a name and one main landmark"; "after a move to each destination the focus is on its heading and the title has changed"; "every destination is reached with Tab and Enter alone"._
- [x] The colour scheme follows the system, can be overridden, and the override survives a reload. _`e2e/shell-color-scheme.spec.ts`: "the page follows the device until a scheme is chosen"; "choosing Light makes the page light at once, and it stays light" (the cookie sent is `__Host-color-scheme=light; Max-Age=31536000; Path=/; Secure; SameSite=Lax`, and the server renders the scheme after a reload and in a new page); "choosing System deletes the cookie and the page follows the device again"; the form also works without script. `test/color-scheme.test.ts` covers the action and the root loader._
- [x] Lighthouse reports an accessibility score of 100 for the shell. _Lighthouse 13.6.0 with Chrome 158 against `/app` on a production build served by `vite preview`: 100 on the mobile form factor and 100 on desktop, no audit below 1. Command: `pnpm dlx lighthouse http://localhost:5391/app --only-categories=accessibility --chrome-flags="--headless=new"`, and the same with `--preset=desktop`. Not in the pipeline; TS-023 and TS-024 put such measurements there._

Beyond the criteria: an axe scan of the four destinations at both widths in both schemes finds no violation; React Aria's locale is negotiated on the server; a RadioGroup component joined the library for the colour-scheme choice. Three things look slightly off and are left for a design pass: in the rail the travelling indicator passes over the labels between the old and the new destination; the skip link, while focused, covers the top of the rail; the radio rings in Settings sit 12px in from the headings above them. `/app` is open to anyone until TS-008's second pass adds the guard; it holds no data.

### TS-005 · Component foundation

Done 2026-11-11. Pull request #13.

- [x] The headless library choice is confirmed against the current documentation of React Aria Components, Base UI and Radix, and `docs/decisions.md` entry 6 is updated with what was found. _Entry 6 now holds the comparison with sources. Measured on the installed versions (React Aria Components 1.22.1, Base UI 1.9.0, Radix 1.8.1): all three write `style` attributes into server HTML for Checkbox, Switch and Select, which the Content Security Policy ignores. Only React Aria documents hooks that let us render those elements ourselves, and only it has the date and time components later cards need. React Aria stays._
- [x] Button, IconButton, TextField, Checkbox, Switch, Select, Menu, Dialog, Sheet, Tabs, Snackbar and Tooltip exist and are styled only with tokens. _Twelve files in `app/components/`. `pnpm lint`: "No raw colours or arbitrary values under app." The HTML of `/design` in a production build contains no `style` attribute and no `<style>` element._
- [x] Each component has a test that operates it by keyboard and asserts its role and accessible name. _`e2e/components.spec.ts`, 13 tests in a real browser against a production build, for example "Dialog takes the focus, keeps it inside, and returns it to the button on Escape". The Tooltip test also uses the pointer once, for hover._
- [x] The `/design` route shows every component in every state in light and dark, and returns 404 in a production build. _`e2e/design.spec.ts`, 6 tests: twelve headings in each scheme; hover, focus and pressed held in place; disabled, invalid and selected shown. An overlay shows its open state when its button is pressed, or by `/design?open=dialog&scheme=dark`. `test/design-route.test.ts`: "answers 404 for /design in a normal build"._
- [x] An automated accessibility scan of `/design` reports no violations. _`e2e/accessibility.spec.ts`, 16 tests with axe: the page closed and with each overlay open, in both schemes, against WCAG 2.0, 2.1 and 2.2 at A and AA, no rule disabled. The scan found one real defect, fixed: a hovered field's label measured 4.33:1 in the light scheme._
- [x] With reduced motion requested, a test finds no animation of position or scale in any component. _`e2e/reduced-motion.spec.ts`: "no component animates position or scale". With the Sheet's reduced-motion classes removed it fails naming the transition; a second test with motion allowed requires ten named movements to be seen, so the watcher is known to work._

Beyond the criteria: every browser test fails on a Content Security Policy violation or a console error, and none occurred, in Chromium and in WebKit on React Aria's iOS path. The policy gained two SHA-256 hashes for the two fixed `<style>` elements React Aria inserts from script; a test fails when the library's text and the hashes disagree. The Motion library was not needed and is not installed: decision 19.

### TS-026 · Close the findings of the foundation security review

Done 2026-11-11. Pull requests #9 and #10. An independent review of the merged foundation found three medium and eleven low findings, none high. What was fixed is below; what was accepted is in `docs/security.md`, "Known gaps and accepted risks".

- [x] A raw SQL filter with a top-level OR cannot read, change or delete another organisation's rows (test). _`test/db/scope.test.ts`: "keeps a raw SQL condition with a top-level OR inside the organisation". With the parentheses removed from `app/db/scope.ts` it fails; restored, it passes._
- [x] An update or delete through the scope names its rows: a missing condition is refused, and every row of the organisation takes `everyRow` (test). _`test/db/scope.test.ts`: "refuses an update or delete whose filter produces no condition". `test/db/scope.typecheck.ts` shows a call without a filter does not compile._
- [x] Tables with an organisation id can be imported only by the data layer: the linter refuses it elsewhere, and a test fails when such a table is missing from the scope or exported (test). _A file under `app/routes/` importing `~/db/schema` fails `biome check` with `lint/style/noRestrictedImports`. `test/db/scope.test.ts`: "covers every table that has an organisation id, and exports none of them"._
- [x] In production the Worker answers only on `timesifier.com`: `www` is redirected and any other host, including the workers.dev address of a version, gets 404; previews and local hosts are served (test). _`test/canonical-host.test.ts` (12 cases) and, through the Worker, `test/browser-policy.test.ts`: "answers 404 on the workers.dev address Cloudflare gives each production version"._
- [x] A request body over the limit is answered 413 and is not read past the limit; a form field named `__proto__` does not change the parsed object's prototype (tests). _`app/lib/validate.test.ts`: "answers 413 for a body that declares more than the limit, and never reads it", "answers 413 for a streamed body once it passes the limit, and stops reading", and the test of a form field called `__proto__`._
- [x] A response that is not HTML carries a policy under which nothing loads, and a WebSocket handshake from a foreign origin is rejected with 403 (tests). _`test/browser-policy.test.ts`: "sends HSTS, nosniff and a policy under which nothing loads on a response that is not HTML", "rejects a WebSocket handshake from a foreign Origin, and lets one from our own through"._
- [x] Closing a pull request cancels a preview that is still being created. _Both workflows put a pull request's runs in the group `ci-pr-<number>`, and the clean-up cancels what is in progress there. The first version of this (pull request #9) used `github.ref`, which for a merged pull request is `main`: the clean-up cancelled the production deploy of its own merge, run 42952382551, before any step ran. Pull request #10 fixed the group; on its merge the clean-up (run 42953098336) and the deploy (run 42953097160) ran side by side and both succeeded. Cancelling an unfinished preview has not been rehearsed._
- [x] Every finding that is accepted rather than fixed is written in `docs/security.md` with the reason and what would close it. _Section "Known gaps and accepted risks": six rows._
- [x] After the deploy, the new version's workers.dev address answers 404 and the smoke test checks it on every deploy. _Run 42953097160 deployed version `264bc1cc` and its smoke test printed "ok: https://264bc1cc-timesifier.ayoinc.workers.dev/ answered 404". Run against a version uploaded before this card, the same script fails: "answered 200, expected 404"._
- [x] On the live site a static asset carries the "nothing loads" policy, and plain HTTP is redirected to HTTPS. _`curl -sI https://timesifier.com/assets/entry.client-ChhaeA7v.js` shows `content-security-policy: default-src 'none'; frame-ancestors 'none'`; `http://timesifier.com/` answers 301 to `https://timesifier.com/`, and the smoke test checks that on every deploy._

### TS-004 · Design tokens

Done 2026-11-11. Pull request #7.

- [x] `pnpm tokens` generates the Material 3 colour roles for light and dark schemes from one seed colour, as CSS custom properties, and the output is committed. _`app/styles/tokens.css` holds 53 `--md-sys-color-*` roles, each as `light-dark(light, dark)`, from `SEED_COLOUR` in `scripts/tokens.ts`. `scripts/tokens.test.ts`: "gives byte-identical output on every run, equal to the committed file"._
- [x] Type scale, shape, spacing, elevation and motion tokens (durations, easings, one spring) exist as CSS custom properties and as Tailwind theme variables. _Counted in `app/styles/tokens.css`: 75 type scale properties (15 roles), 10 corners, 1 spacing unit, 6 elevation levels, 16 durations, 10 easings, 4 for the spring. `app/app.css` points 162 Tailwind theme variables at them. Compiling it emits `text-headline-medium`, `bg-primary`, `rounded-medium`, `shadow-level2`, `ease-emphasized`, `duration-short4` and `p-4`, and nothing for `text-3xl`, `bg-red-500`, `rounded-lg`, `shadow-md` or `ease-in-out`: Tailwind's own scales are cleared._
- [x] `pnpm check:tokens` exits non-zero when a file under `app/` contains a hex colour or an arbitrary Tailwind value; a test fixture proves it. _`node scripts/check-tokens.ts scripts/fixtures/check-tokens/dirty` exits 1 and lists nine findings; on `app/` it exits 0. `scripts/check-tokens.test.ts`: "fails on the dirty fixture and lists every raw value with its file, line and match", "passes array indexing, index signatures, attribute selectors and URL fragments". `pnpm lint` now runs it._
- [x] A test checks every text colour role against its background role in both schemes: each pair is at least 4.5:1. _`scripts/tokens.test.ts`, "colour roles": 39 pairs in each scheme, 78 cases, all pass at standard contrast with no adjustment._
- [x] The Tokens table in `docs/design-system.md` is filled in. _Eight rows: seed, colour roles, typeface, type scale, shape, spacing, elevation, motion; and how to change the seed._

### TS-007 · Database foundation

Done 2026-11-11. Pull request #6.

- [x] The D1 database is created in the EU; the option used is confirmed against Cloudflare's documentation and written in `docs/architecture.md`. _`wrangler d1 create <name> --jurisdiction eu`; `wrangler d1 list --json` reports `"jurisdiction":"eu"` for `timesifier` and `timesifier-preview`. Confirmed against <https://developers.cloudflare.com/d1/configuration/data-location/>: a jurisdiction keeps the database running and storing data inside the region, where a location hint is only a preference._
- [x] `pnpm db:migrate:local` builds the schema from an empty database using committed SQL migrations. _After `rm -rf .wrangler/state/v3/d1`, the command applied `0000_init.sql` ("8 commands executed successfully"); `sqlite_master` then listed `users`, `organisations` and `memberships`; a second run printed "No migrations to apply!"._
- [x] Tables `users`, `organisations` and `memberships` exist with time-sortable ids and UTC timestamps. _`test/db/schema.test.ts`: "has the users, organisations and memberships tables", "gives each new row a UUIDv7 id that carries its creation time", "stores timestamps as integer milliseconds since the Unix epoch". `test/db/uuidv7.test.ts`: ids from later milliseconds sort after earlier ones; 10,000 ids are unique._
- [x] A test seeds two organisations and shows that the organisation-scoped data layer returns no rows of one to a caller scoped to the other. _`test/db/scope.test.ts`: "selects the rows of its own organisation and none of another's", and the same for update and delete; "cannot insert into another organisation, even when the values name it"; "cannot move a row to another organisation with an update". Removing the organisation filter from the code failed five of them._
- [x] Remote migrations run only from the pipeline; the README says so. _Pull request #6: the `preview` job applied `0000_init.sql` to `timesifier-preview` ("Executed 8 commands"). Its merge started run 42948925785, whose `deploy` job applied the same file to `timesifier` before deploying version `166533bb`; production then listed the tables `users`, `organisations` and `memberships`. The README states the rule, and `package.json` has no script that migrates a remote database._

### TS-010 · Security headers and request checks

Done 2026-11-11. Pull request #5.

- [x] Every HTML response carries a Content Security Policy with a per-request nonce and no `unsafe-inline`, plus HSTS, `frame-ancestors 'none'`, Referrer-Policy and Permissions-Policy (test). _`test/browser-policy.test.ts`, run against the Worker's real handler: "sends the full policy on an HTML page, with the page's scripts carrying the nonce", "uses a different nonce for every request", "sends the same policy on a 404 page". In headless Chrome against a production build, `/` and a 404 page raised no policy violation and hydrated._
- [x] A state-changing request whose `Origin` is not the application's is rejected with 403 (test). _`test/browser-policy.test.ts`, "origin check on state-changing requests": POST, PUT, PATCH and DELETE with a foreign `Origin`, `Origin: null`, or `Sec-Fetch-Site: cross-site` or `same-site` receive 403; the application's own origin, a request with neither header, and a GET pass._
- [x] Every action validates its input with a schema; a test sends malformed input to each and receives 400. _`app/lib/validate.test.ts` (10 tests) proves the helper: typed data for valid input, 400 for malformed form data and JSON, submitted values never echoed. `test/action-validation.test.ts` finds every route with an action and fails for one without a malformed-input case; it was shown failing with a temporary action. The application has no actions yet, so the list of cases is empty._
- [x] securityheaders.com grades production A or better, once TS-003 is done. _Grade A+ for `https://timesifier.com/`, report time 11 Nov 2026 02:49:04 UTC, after run 42948361495 deployed version `41b1b1d9`. The scanner calls six Permissions-Policy directives invalid, among them `publickey-credentials-create`; they are features its list does not know, and Chrome logged no complaint about them._

### TS-003 · Pipeline: preview and production deploys to timesifier.com

Done 2026-11-11. Pull request #4.

- [x] The zone's DNS records are exported before the change and after it. The only differences are the Worker custom-domain records for `timesifier.com` and `www.timesifier.com`. _Before: the 26 record values then known, captured one by one. After: the same 26 values, and new address records for the apex and `www`. The capture before missed one record, `paperclip` (another Worker's custom domain), so the dashboard's own list was checked as well: of 29 records, exactly two were created or modified on 2026-11-11, `timesifier.com AAAA 100::` and `www.timesifier.com AAAA 100::`, both at 02:26 UTC; the newest change to any other record is dated 2026-09-28._
- [x] `dig MX timesifier.com` and the zone's SPF, DKIM and DMARC records return the same values before and after. _`dig +short MX timesifier.com` returned `0 timesifier-com.mail.protection.outlook.com.` both times; `diff` of the two captures shows no MX, TXT or CNAME line changed._
- [x] The pipeline's Cloudflare token is limited to this account's Workers and D1 and to this zone, and is stored as a GitHub Actions secret. _Token `timesifier-ci-deploy`: Editor on the Worker `timesifier` only, Workers Routes on the zone `timesifier.com` only, D1 write on the account, expires 2027-11-11. With it, another Worker's settings answered "No access to the specified resource" and this zone's DNS records answered "Authentication error". `gh secret list` shows `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. D1 write covers every database in the account because Cloudflare offers no narrower scope; see `docs/architecture.md`._
- [x] A smoke test after each deploy fails the workflow when the home page does not return 200. _`scripts/smoke.sh` against a live preview: "ok … answered 200", exit 0. Against the same URL after the preview was deleted: "FAIL … answered 404, expected 200", exit 1._
- [x] The rollback command is written in `docs/architecture.md`, and one rollback has been carried out and recorded on this card. _2026-11-11 02:36:49 UTC: `wrangler rollback d1625379-615a-4bf9-bdb8-d6fdb2da73b7` moved production from version `05a58e49` to `d1625379`; the home page answered 200. 02:37:07 UTC: returned to `05a58e49`; 200 again._
- [x] Merging to `main` deploys to production: `curl -sI https://timesifier.com` returns status 200, and `https://www.timesifier.com` redirects to the apex. _Merging pull request #4 started run 42947786765: `checks`, `secret scan` and `deploy` succeeded, version `e0bb96e6` went live, and the smoke test printed "ok: https://timesifier.com/ answered 200" and "ok: https://www.timesifier.com/smoke?check=1 redirects to the apex". The very first deploy was made by hand, because a token limited to one Worker cannot create it._
- [x] Each pull request receives a comment with its preview URL. _Pull request #4 received "Preview of d1b50a6: https://pr-4-timesifier.ayoinc.workers.dev" from `github-actions`, and that URL answered 200. Closing the pull request deleted the preview: the URL then answered 404._

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
