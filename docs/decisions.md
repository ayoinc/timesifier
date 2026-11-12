# Decisions

Settled choices and the evidence behind them. A settled choice stays settled; to change one, add a new entry that names the entry it replaces. An entry is otherwise changed in one way only: the card that confirms it appends its evidence, with the date.

Entries 1 to 21 were decided on 2026-11-11; later entries carry their own date. "Preparer" in the "How" column means the person who prepared the project chose, for the reasons listed. For entries 3, 4 and 6 to 13 a judgement model was also asked twice, with the options in opposite order, and gave the same answer both times. Treat that as a check that the evidence is consistent, not as independent research.

| #   | Decision            | Chosen                                                                                                                             | How      | Status                                  |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------- |
| 1   | Hosting             | Cloudflare only                                                                                                                    | Owner    | Settled                                 |
| 2   | First release       | Web platform; native tracking clients later                                                                                        | Preparer | Awaiting owner                          |
| 3   | Web framework       | React Router v8, framework mode, server rendering                                                                                  | Preparer | Settled                                 |
| 4   | Design system       | Material 3 Expressive tokens on our own components                                                                                 | Preparer | Settled; TS-030's entry will replace it |
| 5   | Design principles   | Simplicity, fluidity, delight                                                                                                      | Owner    | Settled                                 |
| 6   | Headless components | React Aria Components                                                                                                              | Preparer | Settled                                 |
| 7   | Data                | D1 as system of record; Durable Objects only when a feature needs real-time coordination                                           | Preparer | Settled                                 |
| 8   | Authentication      | Better Auth inside the Worker                                                                                                      | Preparer | Amended by 22 and 23                    |
| 9   | Styling             | Tailwind CSS v4 with tokens as theme variables                                                                                     | Preparer | Settled                                 |
| 10  | Motion              | View Transitions API plus the Motion library                                                                                       | Preparer | Amended by 19 and 21                    |
| 11  | Pipeline            | GitHub Actions                                                                                                                     | Preparer | Settled                                 |
| 12  | Package manager     | pnpm                                                                                                                               | Preparer | Settled                                 |
| 13  | Tests               | Vitest in the Workers runtime, plus Playwright                                                                                     | Preparer | Settled                                 |
| 14  | Lint and format     | Biome                                                                                                                              | Preparer | Settled                                 |
| 15  | Board               | `BOARD.md` in the repository                                                                                                       | Preparer | Settled                                 |
| 16  | Seed and typeface   | Seed colour `#4F5BD5`; Roboto Flex, self-hosted                                                                                    | Preparer | Replaced by 24                          |
| 17  | Ids and timestamps  | UUID version 7 text ids; integer timestamps in milliseconds since the Unix epoch                                                   | Preparer | Settled                                 |
| 18  | Input and origin    | Zod 4 validates every action's input; the Worker rejects cross-origin state changes                                                | Preparer | Settled                                 |
| 19  | Motion library      | Not added yet: components animate with CSS transitions on the motion tokens (amends 10)                                            | Preparer | Settled                                 |
| 20  | Organisation        | Named by each request and checked on the server; never the session's active organisation                                           | Preparer | Settled                                 |
| 21  | Route transitions   | React's `<ViewTransition>`, not React Router's `viewTransition` props (refines 10)                                                 | Preparer | Settled                                 |
| 22  | Sign-in code        | Works only in the browser that asked for it                                                                                        | Preparer | Amended by 23 and 27                    |
| 23  | Passkeys            | None: the emailed code is the one way to sign up and sign in (amends 8 and 22)                                                     | Owner    | Settled                                 |
| 24  | Visual direction    | Seed `#FEAD05` and ink `#252A2F`, the mark's two colours, fidelity scheme; Sofia Sans in two widths, self-hosted (replaces 16)     | Preparer | Awaiting owner                          |
| 25  | Time entries        | One running entry for a person in an organisation; a project is required                                                           | Owner    | Settled                                 |
| 26  | Time zone           | An IANA name stored on the person; an entry belongs to the local day it starts in                                                  | Owner    | Settled                                 |
| 27  | Lock-out by code    | Codes counted apart for browsers that have signed in as the address; their code is theirs alone (narrows the gap of 23, amends 22) | Owner    | Settled                                 |
| 29  | Teams               | Our own tables unless the teams card shows Better Auth's built-in teams fit; settled on TS-038                                     | Owner    | Open until TS-038                       |

Numbers 24 and 28 are kept for entries that arrive with their cards: the visual direction (TS-030), and whether `style` attributes stay banned (the owner's, before TS-012b).

## Evidence

### 2. First release is the web platform

The 2025 PRD put a desktop app and a browser extension in the first release. Those run outside Cloudflare and need their own build, signing and store review. The web platform holds the accounts, data model and API they would depend on, so it comes first.

### 3. React Router v8

Checked against Cloudflare's framework guides, both last updated 5 Nov 2026.

| Option              | Evidence                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React Router v8     | Official guide and `create-cloudflare` template with the Cloudflare Vite plugin. Server rendering on. Bindings reach loaders and actions through `context.cloudflare`. Durable Objects and Workflows export from the Worker entry file. Long history as Remix. |
| TanStack Start      | Official guide and template. Typed server functions. Supported on Cloudflare since October 2025. Queues, Cron and Durable Objects need a custom server entry.                                                                                                  |
| React SPA with Hono | Simplest. No server rendering for public pages. Conventions assembled by hand.                                                                                                                                                                                 |
| Next.js             | Runs on Workers only through the OpenNext adapter.                                                                                                                                                                                                             |

### 4. Material 3 tokens on our own components

| Option                                        | Evidence                                                                                                                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens on headless components                 | Material 3 Expressive supplies colour roles, type scale, shape and motion. We own the components, so motion and gradual revelation are under our control. More component work up front.                                            |
| `@material/web`                               | In maintenance mode since June 2024; roadmap reviewed 31 Jul 2026 still says no new features. Never built: navigation bar, rail and drawer, top app bar, card, data table, date and time pickers, snackbar, tooltip, bottom sheet. |
| MUI                                           | Actively released (v9 in 2026). Implements Material Design 2; Material 3 is an open request.                                                                                                                                       |
| Community Material 3 Expressive React library | 41 components, MIT. 9 GitHub stars, no forks, one publisher.                                                                                                                                                                       |

### 5. Simplicity, fluidity, delight

From Benji Taylor's essay _Family Values_ (benji.org/family-values, 8 Jul 2024): "Simplicity ensures accessibility, fluidity maintains continuity of experience, and delight fosters meaningful connections." `docs/design-system.md` turns them into rules that can be checked.

### 6. React Aria Components

Confirmed for TS-005 on 11 Nov 2026, against each library's current documentation and by rendering each library's components to HTML with the installed versions. The choice stands.

| Point                                                                       | React Aria Components 1.22.1 (9 Oct 2026)                                                                                                                                                                                                                 | Base UI 1.9.0 (9 Oct 2026)                                                                                                                            | Radix `radix-ui` 1.8.1 (12 Oct 2026)                                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The twelve components of TS-005                                             | All twelve. `Sheet` is new in 1.22.0. Toast is still exported as `UNSTABLE_Toast`.                                                                                                                                                                        | All twelve, with `Drawer` as the sheet and `Field` with `Input` as the text field.                                                                    | No button, text field or sheet; the rest are present.                                                                                                       |
| Calendar, DatePicker, DateRangePicker, TimeField                            | All four, and RangeCalendar.                                                                                                                                                                                                                              | None. The tracking issue is open (mui/base-ui issue 1709).                                                                                            | None.                                                                                                                                                       |
| React 19 and server rendering                                               | Peer range includes React 19; ids come from `useId`.                                                                                                                                                                                                      | Peer range includes React 19.                                                                                                                         | Peer range includes React 19; documented as server-renderable.                                                                                              |
| What the documentation says about Content Security Policy                   | A nonce in `<meta property="csp-nonce">`, which the library puts on the `<style>` elements it inserts. No word on `style` attributes.                                                                                                                     | A `CSPProvider` that puts a nonce on its inline `<style>` and `<script>` elements, or disables the `<style>` elements. No word on `style` attributes. | No guide. A `nonce` prop on ScrollArea and on the Select viewport. A discussion (3130), closed without a fix, notes that most primitives use inline styles. |
| `style` attributes in server-rendered HTML (measured with `renderToString`) | Checkbox, Switch and Select: the visually hidden native input or select. Calendar, DatePicker, DateRangePicker and TimeField: hidden helpers and each date segment. None on Button, TextField, Tabs, or any closed Menu, Dialog, Sheet, Tooltip or Toast. | Checkbox, Switch and Select: the visually hidden native input.                                                                                        | Checkbox, Switch, Select, Tabs and Toast.                                                                                                                   |
| A way to render those elements ourselves                                    | Yes: the documented hooks in `react-aria` and `react-stately` (`useCheckbox`, `useSwitch`, `useSelect` with `useHiddenSelect`) return the props and leave the markup to us.                                                                               | No.                                                                                                                                                   | No.                                                                                                                                                         |

Sources: react-aria.adobe.com (`llms.txt` for the component list, `frameworks`, `styling`, `Sheet`, `Toast`, `releases/v1-22-0`); base-ui.com (`llms.txt`, `react/utils/csp-provider`); radix-ui.com/primitives (`docs/components/select`, `scroll-area`, `docs/guides/server-side-rendering`); the npm registry record of each package for versions, dates and peer ranges.

Every library breaks `style-src 'self'` as shipped, and only React Aria offers a supported way round it, so it is also the only one that can meet the policy. What it took:

- **Checkbox, Switch and Select are built on React Aria's hooks**, with the native input or select hidden by a class. `react-aria` and `react-stately` are direct dependencies at the exact versions React Aria Components resolves. The other nine use the components as they come.
- **React Aria inserts two `<style>` elements from script** (`usePress`, and on iOS `usePreventScroll`). Each is a fixed text, so the policy allows each by its SHA-256 hash; a test derives the hashes from the installed library. See `docs/security.md`, "Content Security Policy".
- **The date and time components will need the same treatment** when their cards come: each date segment carries a `style` attribute (`caret-color`), and the calendar and the date fields render visually hidden helpers. `useDateField`, `useDateSegment` and `useCalendar` are the hooks to build on. Check with `renderToString` before using one.

### 7. D1 first

One D1 database, every tenant row carrying an organisation id, gives simple reports and ordinary migrations. A Durable Object per organisation isolates more strongly but makes cross-team reports and migrations harder. Durable Objects join when a feature needs live coordination: a change that must be pushed to a person's other devices within a second.

Added on 2026-11-11 by TS-031, from Cloudflare's D1 limits page (<https://developers.cloudflare.com/d1/platform/limits/>):

- **The numbers.** A D1 database stops at 10 GB, and that limit cannot be raised. It runs one query at a time, so its throughput is one divided by the length of a query. A time entry is estimated at about 0.5 KB with its indexes, which is not yet measured; at that size 20 million entries fill the database.
- **The warning.** TS-022a adds an alert when the production database passes 5 GB.
- **The exit, named now.** Storage for each organisation: a database or a Durable Object of its own. `organisationScope` is the one module that would change, because every read and write of customer data already goes through it.
- **The rule.** Rows that arrive in high volume, such as audit records or imported calendar events, enter the shared database only with a period after which they are deleted.

### 8. Better Auth

Runs inside the Worker and keeps identities in our own D1 database. Supports email, passkeys, two-factor, organisations and roles. Cloudflare Access is built for a company's own workforce, not public sign-up. A hosted identity service would leave the Cloudflare stack. Hand-written authentication carries the most risk.

TS-008 confirmed the rest on 2026-11-11 against Better Auth's documentation for 1.7 and by running `better-auth` 1.7.19 and `@better-auth/passkey` 1.7.19, both pinned to that exact version. 1.7.20 was a day newer; it was published less than 24 hours before, which pnpm's release-age rule refuses, so the build uses 1.7.19 rather than make an exception to the rule. The tests pass on both.

**The route to D1.** The documentation gives two (<https://better-auth.com/docs/concepts/database>, "Example: Cloudflare D1"): hand the `DB` binding to Better Auth, which then uses its built-in Kysely adapter and creates its own tables through a migration endpoint; or use the Drizzle or Prisma adapter and migrate with that tool. We use the Drizzle adapter (<https://better-auth.com/docs/adapters/drizzle>) over the `drizzle-orm/d1` client the application already has.

| Option                               | Evidence                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drizzle adapter, hand-written tables | One schema file and one migration tool for the whole database. The tables keep the house style: plural snake_case names, UUIDv7 ids (`advanced.database.generateId`), millisecond timestamps. Better Auth compares its models with the tables on start-up and every request waits for that check. |
| The `DB` binding, built-in adapter   | Fewer lines. Better Auth would create a second set of tables with its own names and id style, outside `migrations/`, through an endpoint that must then be protected or removed. `getMigrations` "does not work with Prisma or Drizzle", so the two routes cannot be mixed.                       |

What was run: every auth test drives the Worker's real fetch handler in the Workers runtime against a local D1 built from `migrations/`. `better-auth/minimal` is imported so the unused Kysely adapter stays out of the bundle, and each plugin from its own path (`better-auth/plugins/email-otp`), because the `better-auth/plugins` barrel loads every plugin.

**One instance per isolate.** The documentation builds the instance once at module scope from `env` imported from `cloudflare:workers`. Ours is built on first use and kept, which is the same thing with one difference: it is rebuilt if a binding it was built from is replaced, so a test can change the Turnstile key.

**Email code, not magic link.** The documentation describes both and recommends neither. A magic link is verified by a `GET` that signs the person in, and decision 18 says a `GET` never changes state. A six-digit code is typed into the page that asked for it, so it also works when the mail is read on another device. Codes are stored hashed, last five minutes and allow three attempts.

**Passkeys.** The plugin's default journey: prove the address with a code, then add a passkey while signed in. Every account therefore has a verified address to fall back on. The relying party id is the host of the request, which is only ever one of our own hosts.

**The `__Host-` cookie.** 1.7.19 and 1.7.20 have no option for it; the request is open upstream as <https://github.com/better-auth/better-auth/issues/10806>. What each configuration sent on 2026-11-11, read from the `Set-Cookie` header in a test:

| Configuration under `advanced`                                                             | Session cookie sent                                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Nothing                                                                                    | `better-auth.session_token`, with no `Secure` at all                                        |
| `useSecureCookies: true` and a cookie named `__Host-timesifier.session_token`              | `__Secure-__Host-timesifier.session_token`: the prefix is added in front of any name        |
| `useSecureCookies: false`, `cookiePrefix: "__Host-timesifier"`, and the attributes by hand | `__Host-timesifier.session_token=…; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax` |

The last row is what ships, and Better Auth reads that cookie back. The first row shows why nothing is left to the defaults: with the address taken from each request, Better Auth cannot know at start-up that it is served over HTTPS, and nothing sets production mode inside a Worker. With the prefix alone, the HTTP layer underneath Better Auth already adds `Secure` and `Path=/` to a name that starts with `__Host-`; the attributes are also set by hand so the cookie does not depend on that. Every cookie Better Auth sets takes the same prefix, including the passkey challenge. When upstream adds an option, moving to it will rename the cookie and sign everyone out once.

On `http://localhost` under `pnpm dev`, Chromium 158 kept the cookie and the next request had the session. WebKit (Safari 27.2) did not: sign-in answered 200 and the next request had no session. Firefox was not tried. Local sign-in and the browser tests therefore use Chromium.

**The rate limit.** Better Auth's own limiter with `storage: "database"`, so the count is one row in D1 shared by every isolate. It is off outside production mode unless `enabled: true` is set, so it is set. The client is the address in `CF-Connecting-IP`. Sending a code, signing in with a code and signing in with a passkey each allow 10 requests; the 11th is answered 429.

The window is neither a calendar minute nor a sliding count. The counter starts again only when 60 seconds have passed since the last request that was let through. Ten attempts 30 seconds apart are therefore followed by a 429, which is stricter than "ten a minute" for a slow, steady client. A refused request does not push the wait further out. `test/auth/rate-limit.test.ts` shows each of these.

Cloudflare's Rate Limiting binding was not used: its documentation says "Rate limits are approximate and apply separately in each Cloudflare location" (<https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>), which cannot promise that the 11th request is refused.

**Turnstile.** The captcha plugin checks the token in the `x-captcha-response` header on the request that sends a code. With email codes there is no separate sign-up request, so that request is the door to sign-up; it is also the one that costs money and reaches a stranger's inbox.

Amended on 2026-11-11 by entry 22 and TS-027: a code has eight digits, not six, and one client may ask for a code three times a minute.

### 9. Tailwind CSS v4

Tokens are declared once as theme variables; `pnpm check:tokens` forbids arbitrary values.

### 10. Motion

Native view transitions for route changes and shared elements; the Motion library for springs and interruptible animation. Entry 19 amends the second half, and entry 21 says how the first is done.

### 11. GitHub Actions

Checks and deploy in one reviewed workflow; the owner's other projects already use it.

### 12. pnpm

Strict resolution and frozen-lockfile installs; supported by `create-cloudflare`.

### 13. Vitest in the Workers runtime, plus Playwright

Tests run against real bindings; Playwright covers what needs a browser: the keyboard, accessibility scans and movement.

### 14. Biome

Biome formats and lints with one tool and one config.

### 15. The board in the repository

The board lives in the repository so that the card, its acceptance criteria and the change that satisfies them are reviewed together.

### 16. Seed colour and typeface

Chosen by the preparer while building TS-004, for the owner to confirm.

- **Seed colour `#4F5BD5`:** an indigo. Every colour role in the light and dark schemes is derived from it by Google's `@material/material-color-utilities` (0.4.0): tonal spot scheme, standard contrast, 2025 specification. With this seed every text role is at least 4.5:1 against its background in both schemes; `scripts/tokens.test.ts` checks it.
- **Roboto Flex:** the variable typeface Material 3 Expressive is drawn with. It is served from our own origin by `@fontsource-variable/roboto-flex` (5.3.0, SIL Open Font License 1.1), weight axis only, so no font request leaves `timesifier.com`.

Both are one-line changes in `scripts/tokens.ts` (`SEED_COLOUR` and `TYPEFACE`), followed by `pnpm tokens`; a different typeface also needs its Fontsource package installed. The steps are in `docs/design-system.md`, under Tokens.

### 17. UUIDv7 ids and epoch-millisecond timestamps

Decided in TS-007, before the first table was created.

**Ids are UUID version 7 (RFC 9562), stored as 36-character lowercase text and generated in the application** by `uuidv7` in `app/db/`, with Web Crypto and no dependency.

| Option                 | Evidence                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UUIDv7 text            | The first 48 bits are the creation time, so ids sort by creation as plain strings and new rows land at the end of the primary-key index. Not guessable from a neighbour: 74 random bits. The id exists before the insert, so related rows can go in one batch. A published standard. |
| Auto-increment integer | Smallest and fastest. Reveals how many rows exist and lets a caller walk them, which matters for a multi-tenant product. The id is known only after the insert.                                                                                                                      |
| UUIDv4                 | Standard and unguessable. Random order scatters inserts across the index and says nothing about creation order.                                                                                                                                                                      |
| ULID, nanoid           | Would need a dependency or a format that is not a standard.                                                                                                                                                                                                                          |

Text, not a 16-byte blob: ids appear unchanged in URLs, logs and the D1 console, and Better Auth expects string ids. Ids created in the same millisecond are unique but not ordered among themselves. An id reveals when its row was created; none of our ids needs to hide that.

**Timestamps are integers holding milliseconds since the Unix epoch**, in columns `created_at` and, where rows change, `updated_at`, set by the application.

| Option                     | Evidence                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Integer epoch milliseconds | The epoch is defined in UTC, so a stored value cannot carry a time zone or be misread as local time. Compares and sorts as a number. It is what `Date.now()` returns and the precision the ids use. Eight bytes at most. |
| ISO 8601 text              | Readable in the console. SQLite has no date type, so nothing stops a value without a zone or in a second format, and comparison is correct only while every value has the same shape. Two to three times the size.       |
| Integer epoch seconds      | What SQLite's `unixepoch()` returns. Loses the order of events within a second, which a timer product needs.                                                                                                             |

Drizzle maps these columns to `Date` (`integer` with mode `timestamp_ms`), so code never handles the raw number.

### 18. Zod 4 for validation, and the origin-check rule

Decided while building TS-010.

**Validation.** Every action starts with `parseRequest` from `app/lib/validate.ts`, which checks the request's form data or JSON against a Zod 4 schema and answers 400 when it does not match.

| Option       | Evidence                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zod 4        | 4.6.7 on 2026-11-11, maintained by Colin McDonnell. No dependencies. One schema gives the check and the TypeScript type. Better Auth (decision 8) already uses it for its own schemas. |
| Valibot      | Smaller in the browser bundle. Validation here runs on the server, where that does not matter. A second schema library beside the one Better Auth brings.                              |
| Hand-written | No dependency. Every action would repeat type guards, and the types could drift from the checks.                                                                                       |

**Origin check.** The Worker answers 403 to a `POST`, `PUT`, `PATCH` or `DELETE` whose `Origin` header is present and differs from the request URL's origin, or whose `Sec-Fetch-Site` header is present and is neither `same-origin` nor `none`. A request with neither header is let through. `GET`, `HEAD` and `OPTIONS` are never blocked.

| Option                        | Evidence                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header check in the Worker    | No state, no token in every form. Browsers send `Origin` on every state-changing request and a page cannot set it or `Sec-Fetch-Site`. Runs before the framework, so it covers resource routes too. |
| React Router's own check only | In 8.5.1 it answers 400 when `Origin` does not match, for page and data requests. Resource routes are not covered, and it does not read `Sec-Fetch-Site`.                                           |
| A token in every form         | Works without trusting headers. Needs a session before the first form, a hidden field in every form and a check in every action; one forgotten check is a hole.                                     |

A request with neither header does not come from a browser, and forgery needs a browser that holds the person's session. Session cookies are `SameSite=Lax` (TS-008) as a second layer. The consequence: a `GET` must never change state.

### 19. The Motion library is not added yet

Decided while building TS-005. It amends entry 10, which named the Motion library for springs and interruptible animation.

The components animate with CSS transitions that read the motion tokens, including the spring, which `pnpm tokens` emits as a CSS `linear()` easing. A CSS transition can be interrupted and reversed part-way, which is what design rule 8 asks for, and it runs under the Content Security Policy as shipped. Adding a library the platform can do without would break the dependency rule in `docs/security.md`.

Motion comes in with the first feature that needs what CSS cannot do: movement driven by a gesture, a spring that carries the velocity of an interrupted movement, or layout animation between two arrangements. The card that adds it says which. Route changes still use the View Transitions API, as entry 10 says.

### 20. The organisation comes from the request, not from the session

Decided while building TS-009.

Every request that acts on an organisation names it: a page by the slug in its address (`/app/<slug>/…`), a call to Better Auth by the organisation's id in its body or query. The server reads the person's membership of that organisation from the database on that request and answers 404 when there is none.

| Option                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The organisation is named by the request | What a request acts on can be read from the request alone, so a link, a second tab and a test all mean one thing. One check, in one place, covers every request. A person in two organisations can have both open at once.                                                                                                                                                                                             |
| The plugin's active organisation         | Better Auth's organization plugin keeps `activeOrganizationId` on the session and, in 1.7.19, its endpoints fall back to it when a request names no organisation. It is state the page does not show: two tabs share one session, so switching in one changes what the other's next request acts on, and an invitation or a removal can land in the wrong organisation. Reading it also ties tenancy to a mutable row. |

How it is held in place: the gate in `app/auth/organisations.server.ts` refuses, with 400, a request to an organisation endpoint that names no organisation, and answers 404 for the endpoint that sets the active organisation. The plugin still writes the column when a person creates or joins an organisation, because its schema requires the column to exist; nothing in the application reads it. `test/organisations/create.test.ts` proves a request without an organisation is refused even when the session has an active one.

### 21. Route transitions use React's `<ViewTransition>`

Decided while building TS-006. It refines entry 10, which named the View Transitions API for route changes without saying through which interface.

| Option                                         | Evidence                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React's `<ViewTransition>` component           | Exported by the installed React 19.3.1 with `addTransitionType`. React Router 8.5.1's own guide (`docs/how-to/view-transitions.md` in the package) names it as the way to do this. A class per kind of change, and named shared elements, with no inline style. |
| React Router's `viewTransition` props and hook | Marked deprecated in React Router 8.5.1 in favour of React's component.                                                                                                                                                                                         |
| Calling `document.startViewTransition` by hand | Works, but the application would have to coordinate it with React's rendering itself.                                                                                                                                                                           |

Two things found while building it, both now rules in `docs/design-system.md`: a boundary whose class is not `none` starts a transition on every render that reaches it, so boundaries are `none` except on a change of destination; and an element taking part in a running transition cannot be pressed, so the navigation stays out of it.

### 22. A sign-in code is used in the browser that asked for it

Decided on card TS-027, after the security review of authentication.

The answer to a request for a code sets a cookie, `__Host-timesifier.sign_in_code`, whose value is an expiry and an HMAC under `BETTER_AUTH_SECRET` of the address and that expiry. A request to sign in with a code is refused, with the answer a wrong code gets and before the code's attempts are touched, unless it carries the cookie made for that address. The consequence a person can notice: a code read on a phone cannot be typed into a laptop that did not ask for it, and a code asked for in one browser does not work in another.

| Option                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A code works only in the browser that asked | A stranger's guesses never reach the code, so they cannot use up its three attempts. Before this, one client sending a wrong guess every six seconds stayed inside the rate limit and spent every code a person asked for within 18 seconds, for as long as it liked (the review's finding 2; `test/auth/email-code.test.ts`, "refuses a stranger's guesses", failed with 403 where it now gets 200). |
| A code works on any device (what was built) | Convenient: read the mail anywhere, type the code anywhere. But the sign-in request then has to accept a guess from anybody who knows the address, and Better Auth 1.7.19 counts attempts per address, not per requester (`plugins/email-otp/routes.mjs`, `atomicVerifyOTP`).                                                                                                                         |
| Turnstile on the sign-in request as well    | Raises the cost of each guess and does not stop the lock-out: three solved challenges still spend a code.                                                                                                                                                                                                                                                                                             |
| A separate code for each requester          | Would also stop one person's request replacing another's code. The plugin keeps one live code per address and offers no other shape; it would mean writing the email-code flow ourselves.                                                                                                                                                                                                             |

What it does not close, and why passkeys are the remedy, is in `docs/security.md`, "Known gaps and accepted risks". The cookie holds no address and is `HttpOnly`; the proof in it counts for the five minutes a code lasts, and the browser keeps it for an hour so that a late code is answered "expired" and not "wrong". The length of a code, eight digits, is one constant, `SIGN_IN_CODE_LENGTH` in `app/auth/code.ts`, read by the server and by the sign-in page.

### 23. No passkeys: the emailed code is the one way in

Decided by the owner on 2026-11-11, on card TS-029. It amends entry 8, under which passkeys shipped beside the email code, and the last paragraph of entry 22, which names passkeys as the remedy for a gap. Where those entries speak of passkeys they describe what was built and has since been removed.

A person signs up and signs in with the emailed code and nothing else. `/sign-in` opens on the email address; `/sign-up` ends when the code is accepted and goes on to where the person was going; Settings has no Passkeys section.

| Option                                            | Evidence                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The emailed code only (chosen)                    | One way in, the same on every device and in every browser, and the same two steps to sign up and to sign in. Every sign-in waits for an email, and the gap below stays open.                                                                                                |
| A passkey first, the code as fallback (was built) | Sign-in with no email and no code, for a person who has made a passkey. It put a view in front of the email step on `/sign-in`, a third step after sign-up, a section in Settings, six endpoints, a table and a second dependency, `@better-auth/passkey`, to keep current. |

What was removed: the passkey plugin and `@better-auth/passkey`; its six endpoints from `app/auth/endpoints.ts`, which now lists 20; its two rate-limit rules and its registration hook; the `passkeys` table, dropped by migration `0005_remove_passkeys` (production held no rows); and the passkey views, their tests and the virtual authenticator the browser tests used. `Permissions-Policy` now denies `publickey-credentials-get` and `publickey-credentials-create` like every other feature.

**What it costs.** Passkeys were the remedy for a known gap (`docs/security.md`, "Known gaps", TS-027): somebody who knows a person's address can use up that address's five codes an hour, or keep replacing the code the person is about to type, and so keep them from signing in. A passkey signs in without a code and was out of that reach. With the code as the only way in, every person is exposed to it and nothing planned closes it. The bounds that remain are the ones entry 22 and the security document describe: each request for a code costs a Turnstile token, one client may ask three times a minute, and guessing a code needs the cookie of the browser that asked.

Bringing passkeys back needs a new entry that names this one, the plugin and the table again, and the two permissions.

### 24. The visual direction: a departure sheet

Replaces entry 16. The owner's verdict on the first release of the interface was that it worked but did not look like a designed product. `docs/design-direction.md` is the answer: who the product is for, the feeling, and what the design refuses to do. It changes values, not the system: the tokens still come from one seed through `scripts/tokens.ts`, and the contrast test still passes with no adjustment.

- **Seed colour, fidelity scheme.** First `#FFD400`, a lemon yellow. The tonal spot scheme mutes any seed to a pastel; the fidelity scheme keeps the seed itself as `primary-container` in both schemes, which is what a yellow sheet needs. Material's own `primary` for a yellow seed is an olive by day and a cream by night, so `PLACED_ROLES` in `scripts/tokens.ts` places `primary` and `on-primary` on other Material roles of the same scheme (ink and yellow), and adds three roles for the sheet. `on-secondary-container` is placed too: Material's measures 4.55:1 at rest and 4.02:1 beneath a pressed state layer, which the accessibility scan of the component gallery refuses. Material's tertiary for this seed is a cyan; the design has one accent, so each tertiary role takes the value of its secondary twin. Every role is still derived from the seed, and the contrast test covers each.
- **Sofia Sans and Sofia Sans Condensed** (Lettersoup, SIL Open Font License 1.1), variable, weight axis, Latin and Latin Extended. One family in two widths, as a timetable is set. The files are copied from the Fontsource packages (5.3.0) into `app/fonts/`, so the two packages are not dependencies; `@fontsource-variable/roboto-flex` is removed.
- **Corners of 2 to 24px** on Material's step names.

| Option                                  | Evidence                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Yellow sheet, condensed grotesque       | Specific to keeping time: the reference is a timetable. Amber with charcoal type measures 7.7:1. No other time tracker on Mobbin on 2026-11-11 used it. |
| Keep indigo and Roboto Flex, add a page | The least work. It is the look of a default Material application, which is the look the owner rejected.                                                 |
| Warm neutral with a serif               | Reads as a writing or note-taking product, and is the most common look of the new landing pages of 2026.                                                |

Amended the same day, when the owner supplied the product's mark after seeing the page. The mark's arrowhead is an amber, `#FEAD05`, and its T a charcoal, `#252A2F`, cooler than the ink the yellow seed gave. One product has one yellow: the seed became the amber, and the charcoal became the ink as a second given colour, placed on the text of the light scheme and on everything set on amber. The alternative, keeping the page's yellow and the mark's amber side by side as brand values outside the scheme, would have put two yellows on every page that shows the mark. Every contrast pair still passes (`scripts/tokens.test.ts`); charcoal on amber is 7.7:1.

### 25. Time entries: one running timer for a person in an organisation

Decided on 2026-11-11, before TS-011a starts. The owner settled the two questions that were open: a project is required, and who may see whose time.

- **One running entry for a person in an organisation.** A unique index on `(organisation_id, user_id) WHERE ended_at IS NULL` holds it in the database, so two requests at once cannot both start a timer. The rule is per organisation because `organisationScope` cannot see across organisations. A person in two organisations can run one timer in each. Making it one per person everywhere would need a table about the person, outside the scope.
- **Stop and start are one step.** `organisationScope` gains `batch`: several scoped statements sent as one D1 batch, which D1 applies all together or not at all. Starting a timer while one runs stops the first and starts the second in one batch, with the same instant as the end of one and the start of the other.
- **The server's clock.** `started_at` and `ended_at` are set by the Worker. A time claimed by the browser is ignored.
- **A project is required.** `time_entries.project_id` is not null. A new person creates an organisation, then a project, then starts a timer (the owner, 2026-11-11). Projects are archived, never deleted, so an entry always has its project.
- **The person's id stays.** `time_entries.user_id` does not cascade. Deleting an account removes the person's name and address and leaves the `users` row, so their entries still add up in the organisation's reports and show as "Deleted person" (TS-021a).
- **Who sees what.** Every role creates, renames and archives projects. A person adds and changes only their own entries. An owner or admin can see and export every member's entries and cannot change them.

The columns and indexes of `projects` and `time_entries` are on cards TS-011a and TS-012a in `BOARD.md`, and move to `docs/architecture.md`, "Tables", when those cards are built.

| Option                                   | Evidence                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A unique partial index (chosen)          | The database refuses the second running row whatever the application does. SQLite, and so D1, supports an index with a `WHERE` clause.                            |
| A check in the action before the insert  | Two requests at once both pass the check. It needs a transaction held across statements, which D1 does not offer to a Worker; `batch` is what it offers.          |
| A Durable Object for each person's timer | Would also push a stop to the person's other devices at once. It adds a platform part for something the page gets by reading again on focus and every 30 seconds. |

### 26. Time zone: a name stored on the person

Decided by the owner on 2026-11-11, before TS-012a starts.

- **Where the zone comes from.** `users.time_zone` holds an IANA name such as `Europe/London`. It is set from the browser the first time the person opens a signed-in page, which for a new account is the page that follows the code, and the person can change it in Settings. A name is accepted only if it is `UTC` or `Intl.supportedValuesOf("timeZone")` holds it. Until one is stored, times are shown in UTC.
- **Which day an entry belongs to.** The whole entry belongs to the local day it starts in, in the zone of the person looking. An entry from 23:30 to 00:30 counts as one hour on the first day. That keeps "every total equals the sum of the entries shown" true without splitting an entry.
- **Nothing about a day is stored.** Entries hold UTC instants (entry 17). The Worker works out the bounds of a day or a week in the person's zone and passes them to SQL as UTC integers. The rule for midnight can therefore change later without touching stored data.
- **Reports and exports.** Reports (TS-014a) and their export (TS-014b) follow the same rule. A report's range of days is bounded in the viewer's zone, `users.time_zone`; it holds the entries that start in that range, each counted whole on the day it starts, a running entry up to the time of the request. Every figure is whole minutes: an entry's length is floored to the minute once and totals add those minutes, so every total equals the sum of the rows shown (TS-091, W07). The CSV has one row for each entry the page lists, its times in UTC, in ISO 8601 with `Z`. The brief for the heading features (2026-11-11) had Reports bound their days in the organisation's zone and cut an entry at each of its midnights. TS-091 reversed that after the production audit of 2026-11-11 (W04, W33): the same entry counted on one day in the Timesheet and on two in Reports, so the two pages disagreed about one person's day, and the CSV listed one entry as two rows.

| Option                                   | Evidence                                                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A name stored on the person (chosen)     | The server can render a page, and later a weekly summary, with no browser present. A person who travels keeps one answer to "which day was that" until they change it.       |
| The browser's zone on each request       | Nothing to store. The server cannot know the zone on the first request, and a job with no browser, such as the weekly summary, has no zone at all.                           |
| One zone for each organisation           | Simple for a team in one place. Wrong for every member somewhere else, and for a person in two organisations.                                                                |
| An entry is split at midnight for totals | Each day's total is exact to the minute. A listed entry then no longer equals what is counted for the day, and the rule would have to be applied everywhere totals are made. |

### 27. A browser that has signed in before is counted apart, and its code is its own

Decided by the owner on 2026-11-11, on card TS-029, the same day as entry 23 and because of it. It narrows the gap entry 23 left open and amends entry 22: the cookie of entry 22 now names one request, not any request of the last five minutes.

The gap: somebody who knows a person's address could use up the five codes an hour the address may be sent, and could replace the code the person was about to type by asking for another. With no passkey there was no way in that did not need a code.

What was built. When a code signs a person in, the browser is given a cookie, `__Host-timesifier.known_browser`, kept for a year: an HMAC under `BETTER_AUTH_SECRET` of the lower-cased address, for each of the last five addresses signed in from that browser. From then on:

- **Two counts.** A request for a code from a browser that holds a proof for the address is counted against five an hour for such browsers. Every other request is counted against five an hour for everybody else. A stranger can use up only the second.
- **A waiting code is its asker's alone.** While the code of a known browser is waiting, a stranger's request is answered like any other and issues nothing, so it cannot replace that code. And a guess is let through to the plugin only from the browser whose request the live code answers, so a stranger who has asked, before or after, cannot use up its three attempts either.
- **One answer.** The status, the body and the cookie set by asking are the same in every case: served or not, known or not, account or none.

| Option                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two counts and a waiting code of one's own (chosen)  | A person on a browser they have used before can always ask and sign in, whatever strangers do: `test/auth/known-browser.test.ts`, "can still ask for a code and sign in when strangers have used up the address's five in an hour", "is not replaced by a stranger's request" and "is not used up by a stranger's guesses". It costs a third cookie, one more row for each address with a code out, and an address may now be sent ten codes an hour and guessed at 30 times. |
| Accept the risk                                      | Nothing to build. Anybody who knows an address and will solve a Turnstile challenge every twelve minutes keeps its owner out for as long as they like, on every browser, and nothing but a passkey, which entry 23 removed, was ever going to end that.                                                                                                                                                                                                                       |
| A code for each requester, so that none replaces any | Would also protect a first sign-in on a new browser. The plugin keeps one live code for an address and compares a guess with the newest alone (`resolveOTP` and `atomicVerifyOTP` in `plugins/email-otp/routes.mjs`, 1.7.19); its `resendStrategy: "reuse"` sends the same code again and does nothing for a code stored as a hash, which ours is. It would mean writing the email-code flow ourselves. Not built.                                                            |

**What the plugin does with a pending code, and what was and was not prevented.** Every request creates a new code row for the address, and a guess is compared with the newest row only, so a request replaces the code before it. Prevented, by rules that run before the plugin and without changing it: a stranger replacing or using up the code a known browser is waiting for. Not prevented: a stranger's request replacing another stranger's code, which is what a first sign-in on a new browser asks for.

**Found on the way.** The cookie of entry 22 proved that a browser had asked for a code for the address within five minutes, and was set on every request, served or not. Anybody who asked could therefore still spend the three attempts of a code sent in answer to somebody else's request: in `test/auth/email-code.test.ts`, "refuses the cookie of a browser that asked for an earlier code", the earlier browser's fourth wrong guess was answered 403, the code used up, where it is now answered 400 and the code still signs in the browser that asked for it. The cookie now carries a number of its request's own, and the server keeps the number of the request the live code answers.

**What stays open** is in `docs/security.md`, "Known gaps", rows TS-029:

- A first sign-in on a new browser, sign-up included, can still be delayed: its request is a stranger's, so the strangers' five can be used up before it, and a stranger's later request replaces its code.
- A proof cannot be withdrawn and signing out does not remove it. Whoever holds a browser that once signed in as an address can do to the known browsers' count what a stranger could do to the one count before.
- While a known browser's code waits, for five minutes at most, the same person asking from a new browser is sent nothing and is not told.

Signing out everywhere does not clear the proof: it signs nobody in, the person who has signed out is the one who needs it next, and a request from one browser cannot reach a cookie in another.

### 29. Teams: not Better Auth's built-in teams, unless the teams card shows they fit

Recorded on 2026-11-11, when the owner said the product has teams and managers. It is settled on card TS-038, before that card builds anything.

- **Where things stand.** An organisation has owners, admins and members, and no teams. TS-009 built no teams because none of its criteria asked for them. Better Auth's organization plugin has a teams feature, and `app/auth/organisations.server.ts` does not turn it on.
- **The starting position.** Teams are tables of our own, reached through `organisationScope` like every other table with an `organisation_id`. They become Better Auth's built-in teams only if TS-038 shows that those fit.
- **What TS-038 must show either way.** A manager is a role held for one team. In the installed Better Auth (1.7.19) a team's member row holds a team and a person and no role, and a person's role is one value for the whole organisation. So the built-in teams do not hold "manager of this team" as they ship. TS-038 says where that role is stored and how the server reads it on every request.
- **What does not change.** The organisation of a request comes from the request (entry 20), and a role is read from the database on every request.

| Option                                 | Evidence                                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Our own tables (the starting position) | The scope and its tests already keep one organisation's rows from another. The role for one team is a column we define.                                                                   |
| Better Auth's built-in teams           | Endpoints for making a team and adding a person come with the plugin. Each would join the list in `app/auth/endpoints.ts`, and the role for one team would still need a place of its own. |

### 30. One way in: one page signs in a person who is new and a person coming back

Decided by the owner on 2026-11-11, on card TS-036: "We don't really need create accounts per se. We just need a word like get started or something like start tracking. When you click that, that's automatically taking us to a login page." It amends entry 23, which kept `/sign-up` as a page of its own; where entries 8, 22, 23 and 27 speak of signing up, or of a sign-up page, they describe what was built then.

`/sign-in` is the one page a person uses without a session: an email address, then the code sent to it. The email-code plugin makes the account of an address the first time a code proves it, so the page never asks which of the two a person is and never says. No name is asked on the way in, and `POST /sign-in/email-otp` no longer takes one; a person sets a name in Settings. `/sign-up` is answered by the Worker with a 302 to `/sign-in`, keeping a safe `next`.

| Option                                                   | Evidence                                                                                                                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One page, an address and a code (chosen)                 | One fewer page and one fewer field. A returning person cannot choose the wrong page. The page and the server say the same to every address, so neither tells anybody whether an address has an account.                                 |
| Two pages (was built)                                    | The name was taken with the account. A person who had an account and opened the page for new people was signed in by it anyway, so the second page told nobody apart; it only asked returning people for a name they had already given. |
| One page, and a third view that asks a new person's name | Asked for by the first draft of the card and dropped: the page would have to learn from the server that the address was new, which is the one thing the server does not say, and the owner asked for fewer steps.                       |

**What it costs.** A person is shown by their email address until they give a name, in the members list and in an invitation they send. And signing in with the wrong one of two addresses makes a second, empty account without a word; the pages such an account lands on say who is signed in and offer the way back (`docs/security.md`, "One way in").

### 31. Light is the default colour scheme

Decided by the owner on 2026-11-11, on seeing both schemes: "the light mode is way better, it looks more beautiful." It amends criterion 4 of card TS-006, under which a page followed the device until a person chose.

A person who has chosen nothing gets the light scheme on every page, whatever their device prefers. Settings offers Light, Dark and "Match my device"; the cookie `__Host-color-scheme` holds the choice, and `system` is a value it can hold, where before the absence of the cookie meant it.

| Option                                   | Evidence                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Light unless the person chooses (chosen) | Every visitor's first sight of the product is the one the owner chose. The server needs no hint from the browser to render it, so there is still no flash and no inline script. |
| Follow the device (was built)            | What a person who set their device to dark expects of most software. Half of first visits would see the scheme the owner thinks the weaker. It stays available, as a choice.    |

**What it costs.** A person whose device is set to dark gets a light page until they find the choice in Settings, and a person who is not signed in has no Settings: the public pages and the sign-in page are light for everybody who has not chosen. Dark is held to the same contrast tests and stays in the accessibility scans.

### 32. Undo a deletion: delete at once, put back from a signed token

Card TS-093 (research/harvest-taste.md, HT-A). Deleting an entry no longer asks first: the snackbar says "Entry deleted." and offers Undo for 8 seconds.

The entry is deleted when the person asks, in one batch with its row in the activity log, and the answer carries a token: what the entry was (its id, project, task, billable, description, times and tags), for whom, in which organisation and when, signed with `BETTER_AUTH_SECRET` (`app/timesheet/undo.server.ts`, the keyed hash of `app/auth/keyed-hash.server.ts`). Undo sends the token back; the server checks the signature, the person, the organisation and that it is at most 60 seconds old, and writes the same entry again with its id, as any new time is written: refused on a day locked since, a day that no longer takes it (TS-090), or a project archived since. The log then holds the deletion and the entry made again.

| Option                                  | Evidence                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete at once, a signed token (chosen) | No migration and no column: the entry is gone from every report, total, export and API answer at once, as the person asked. Nothing has to run later to finish a deletion, and one that is never undone needs nothing more. The token cannot be written by the page. |
| Soft delete, removed after 8 seconds    | Every read of `time_entries` (reports, totals, exports, the API, invoices) would have to leave out entries marked deleted, and something would have to remove them later, which a Worker without a schedule for it does not do.                                      |
| Keep the confirmation sheet             | Slower for every deletion and still no way to take a mistake back (the taste review's item 6).                                                                                                                                                                       |

**What it costs.** The token holds the entry's description, signed but not encrypted, in the page's memory for a minute; it is the person's own description, which the page has shown them. The server takes it for 60 seconds, longer than the 8 seconds the snackbar shows Undo, so a slow answer still lands.
