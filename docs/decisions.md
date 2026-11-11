# Decisions

Settled choices and the evidence behind them. A settled choice stays settled; to change one, add a new entry that names the entry it replaces.

Every entry below was decided on 2026-11-11. Entries marked _Jev_ were ruled by a calibrated judgement model on the evidence listed, asked twice with the options in opposite order; the answer was the same both times. The criteria were written by the person preparing the project, so treat the ruling as a consistency check on the evidence, not as independent research.

| #   | Decision            | Chosen                                                                                   | How                                |
| --- | ------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | Hosting             | Cloudflare only                                                                          | Owner                              |
| 2   | First release       | Web platform; native tracking clients later                                              | Preparer, for the owner to confirm |
| 3   | Web framework       | React Router v8, framework mode, server rendering                                        | Jev                                |
| 4   | Design system       | Material 3 Expressive tokens on our own components                                       | Jev                                |
| 5   | Design principles   | Simplicity, fluidity, delight                                                            | Owner                              |
| 6   | Headless components | React Aria Components                                                                    | Jev                                |
| 7   | Data                | D1 as system of record; Durable Objects only when a feature needs real-time coordination | Jev                                |
| 8   | Authentication      | Better Auth inside the Worker                                                            | Jev                                |
| 9   | Styling             | Tailwind CSS v4 with tokens as theme variables                                           | Jev                                |
| 10  | Motion              | View Transitions API plus the Motion library                                             | Jev                                |
| 11  | Pipeline            | GitHub Actions                                                                           | Jev                                |
| 12  | Package manager     | pnpm                                                                                     | Jev                                |
| 13  | Tests               | Vitest in the Workers runtime, plus Playwright                                           | Jev                                |
| 14  | Lint and format     | Biome                                                                                    | Preparer                           |
| 15  | Board               | `BOARD.md` in the repository                                                             | Preparer                           |
| 16  | Seed and typeface   | Seed colour `#4F5BD5`; Roboto Flex, self-hosted                                          | Preparer, for the owner to confirm |
| 17  | Ids and timestamps  | UUID version 7 text ids; integer timestamps in milliseconds since the Unix epoch         | Preparer                           |
| 18  | Input and origin    | Zod 4 validates every action's input; the Worker rejects cross-origin state changes      | Preparer                           |

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

One D1 database, every tenant row carrying an organisation id, gives simple reports and ordinary migrations. A Durable Object per organisation isolates more strongly but makes cross-team reports and migrations harder. Durable Objects join when a feature needs live coordination, such as one timer shown on several devices.

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

### 9 to 13. Tooling

- **Tailwind v4:** tokens declared once as theme variables; `pnpm check:tokens` forbids arbitrary values.
- **Motion:** native view transitions for route changes and shared elements; the Motion library for springs and interruptible animation.
- **GitHub Actions:** checks and deploy in one reviewed workflow; the owner's other projects already use it.
- **pnpm:** strict resolution and frozen-lockfile installs; supported by `create-cloudflare`.
- **Vitest in the Workers runtime:** tests run against real bindings; Playwright covers a few end-to-end and accessibility checks.

### 14 and 15. Biome and the board

Biome formats and lints with one tool and one config. The board lives in the repository so that the card, its acceptance criteria and the change that satisfies them are reviewed together.

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

## To verify when the code is scaffolded

These facts move fast. TS-001 records the exact versions in `docs/architecture.md`.

- Current versions of React Router, the Cloudflare Vite plugin, Wrangler, Better Auth, Drizzle, React Aria Components, Tailwind and Motion.
- D1's options for keeping data in the EU.
