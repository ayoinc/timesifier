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

It ships accessible Calendar, RangeCalendar, DatePicker, DateRangePicker and TimeField, which a time and scheduling product needs. Base UI and Radix supply general primitives without calendar or date-time components. _The Base UI and Radix component lists were taken from memory, not checked this month; TS-005 confirms before building._

### 7. D1 first

One D1 database, every tenant row carrying an organisation id, gives simple reports and ordinary migrations. A Durable Object per organisation isolates more strongly but makes cross-team reports and migrations harder. Durable Objects join when a feature needs live coordination, such as one timer shown on several devices.

### 8. Better Auth

Runs inside the Worker and keeps identities in our own D1 database. Community guides reach D1 through Drizzle or Kysely; TS-008 confirms the supported route against Better Auth's own documentation. Supports email, passkeys, two-factor, organisations and roles. Cloudflare Access is built for a company's own workforce, not public sign-up. A hosted identity service would leave the Cloudflare stack. Hand-written authentication carries the most risk.

### 9 to 13. Tooling

- **Tailwind v4:** tokens declared once as theme variables; `pnpm check:tokens` forbids arbitrary values.
- **Motion:** native view transitions for route changes and shared elements; the Motion library for springs and interruptible animation.
- **GitHub Actions:** checks and deploy in one reviewed workflow; the owner's other projects already use it.
- **pnpm:** strict resolution and frozen-lockfile installs; supported by `create-cloudflare`.
- **Vitest in the Workers runtime:** tests run against real bindings; Playwright covers a few end-to-end and accessibility checks.

### 14 and 15. Biome and the board

Biome formats and lints with one tool and one config. The board lives in the repository so that the card, its acceptance criteria and the change that satisfies them are reviewed together.

## To verify when the code is scaffolded

These facts move fast. TS-001 records the exact versions in `docs/architecture.md`.

- Current versions of React Router, the Cloudflare Vite plugin, Wrangler, Better Auth, Drizzle, React Aria Components, Tailwind and Motion.
- Better Auth's supported way to use D1.
- D1's options for keeping data in the EU.
- Whether rate limiting is done with a Workers binding or a zone rule.
