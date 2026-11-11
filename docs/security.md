# Security

The baseline every change is held to. Each control names the card that puts it in place, and that card's acceptance criteria prove it.

Timesifier holds personal data: who worked on what, and when. The owner is in the UK, so UK GDPR applies from the first real user.

## Controls

| Area          | Control                                                                                                                                                                                                                                           | Card   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Identity      | Passkeys first, email as the fallback: a one-time code sent to the address, which is also how the address is first proved. No passwords. Optional two-factor is not built yet.                                                                    | TS-008 |
| Sessions      | Cookie is `HttpOnly`, `Secure`, `SameSite=Lax` with the `__Host-` prefix. A person can end all their sessions, and that takes effect on the next request.                                                                                         | TS-008 |
| Abuse         | Sending a sign-in code, signing in with a code and signing in with a passkey each allow one client 10 requests a minute; the 11th gets 429. The request that sends a code, which is how an account starts, is checked by Turnstile on the server. | TS-008 |
| Authorisation | Denied unless allowed. Roles are checked on the server for every action.                                                                                                                                                                          | TS-009 |
| Tenancy       | Customer data is reached only through the organisation-scoped data layer. A test proves one organisation cannot read another's rows.                                                                                                              | TS-007 |
| Input         | Every loader and action validates its input against a schema. Every action starts with `parseRequest`, which answers 400 when the body does not match.                                                                                            | TS-010 |
| Browser       | Content Security Policy with nonces, HSTS, `frame-ancestors 'none'`, Referrer-Policy, Permissions-Policy. State-changing requests are checked for origin.                                                                                         | TS-010 |
| Secrets       | None in the repository. A secret scan runs on every pull request.                                                                                                                                                                                 | TS-002 |
| Supply chain  | Frozen lockfile; pnpm refuses a package published less than a day ago; the audit fails on a moderate or worse advisory; third-party actions pinned to a commit; workflows read-only by default                                                    | TS-002 |
| Deployment    | The pipeline's token reaches this Worker, this zone's Worker routes and the account's D1 databases. Scope and expiry: `docs/architecture.md`.                                                                                                     | TS-003 |
| AI            | Text from users is data, never instructions. Output is a suggestion a person accepts. Spend is capped.                                                                                                                                            | TS-015 |
| Audit         | Sign-in, role changes, exports and deletions are recorded.                                                                                                                                                                                        | TS-020 |
| Data rights   | A person can export their data and delete their account. Retention is written down.                                                                                                                                                               | TS-021 |
| Logging       | Structured logs with no secrets and no entry text.                                                                                                                                                                                                | TS-022 |
| Recovery      | The database can be restored to a point in time; one restore has been rehearsed.                                                                                                                                                                  | TS-022 |
| Review        | A threat model covers each part of the system; high findings are fixed.                                                                                                                                                                           | TS-019 |

## Authentication

Better Auth runs inside the Worker (`app/auth/auth.server.ts`) and answers every request under `/api/auth/`. The tests in `test/auth/` drive it through the Worker and hold what is written here in place.

### Flows

- **Email code.** A person asks for a code for an address; the request carries a Turnstile token. A six-digit code is emailed. Sending it back signs the person in and, the first time, creates their account with the address marked verified. The answer to "send me a code" is the same whether or not the address has an account.
- **Passkey.** A signed-in person can add a passkey; after that they sign in with it, and the email code remains the fallback. The relying party is the host the request was made to.
- **Sign-out** ends the session the cookie belongs to. **Ending all sessions** ends every session the person has, this one included.
- There are no passwords. Better Auth's password endpoints answer 400, and the email-code plugin's password-reset and change-of-address endpoints are switched off.

### What is stored

| Table           | Holds                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `users`         | Name, email address, whether the address is verified                                                                            |
| `sessions`      | The session token, its expiry, the client address and user agent it was created from                                            |
| `verifications` | A hash of each emailed code with its count of attempts, for five minutes; the challenge of a passkey ceremony, for five minutes |
| `passkeys`      | The public key, credential id and counter of each passkey. The private key never leaves the person's device                     |
| `rate_limits`   | One counter per client address and sign-in path                                                                                 |

A code is stored only as a hash, works once, and stops working after three wrong attempts or five minutes. The session cookie holds the token and a signature made with `BETTER_AUTH_SECRET`; the session itself is read from the database on every request, never from a copy in a cookie, so an ended session is refused at once.

### The cookie

`__Host-timesifier.session_token`, with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` and no `Domain`. The `__Host-` prefix makes the browser accept the cookie only over HTTPS and send it only to the exact host that set it. Better Auth has no option for this prefix yet; how it is configured, and what to do when one arrives, is in `docs/decisions.md` entry 8. Do not rewrite the `Set-Cookie` header in the Worker: Better Auth would stop recognising its own cookie.

### Hosts

Better Auth takes the application's address from the request only when the host is `timesifier.com`, a preview (`*-timesifier.ayoinc.workers.dev`) or `localhost`. A request for any other host gets 404 from the mount before Better Auth sees it: no cookie is set and no session is read (`app/auth/hosts.ts`).

### Abuse

- **Rate limit.** Counted in D1 per client address and path. The address is `CF-Connecting-IP`, which Cloudflare sets and a client cannot forge; `X-Forwarded-For` is ignored. The count starts again 60 seconds after the last request that was let through. The limit applies only to requests that arrive at `/api/auth/`: server code that calls Better Auth directly is not limited, so sign-in must never be offered through another route.
- **Turnstile.** The token is sent in the `x-captcha-response` header and verified with Cloudflare before a code is created. A missing token gets 400 and a rejected one 403; neither creates nor sends a code. Passkey sign-in is not behind Turnstile: it sends no email and cannot create an account.

### Email

`sendEmail` in `app/auth/email.server.ts` is the only code that touches the `EMAIL` binding. Every message comes from `Timesifier <no-reply@mail.timesifier.com>`, and `wrangler.jsonc` allows the binding that sender and no other. The code email is plain text and plain HTML with no link, image or tracking. Sending is handed to `waitUntil`, so how long it takes does not show in the response. A preview has no `EMAIL` binding and sends nothing; locally Wrangler simulates the binding and sends nothing either.

### Never logged

No log line carries an email address, a code, a cookie or a session token. The email sender logs the recipient's domain only, and the error code of a failed send without its message. `test/auth/email.test.ts` reads every line logged during a whole sign-in and fails if one of those values appears.

### The one action without `parseRequest`

`app/routes/api.auth.$.ts` hands the request to Better Auth untouched. Better Auth checks each endpoint's body against its own Zod schema and answers 400 for a body that is not JSON or does not match, and 415 for a content type other than JSON; reading the body first with `parseRequest` would consume it. `test/action-validation.test.ts` holds the 400 in place like any other action.

## Browser policy

Set by the Worker in `workers/app.ts` on every response it produces. The tests in `test/browser-policy.test.ts` hold it in place.

### One host in production

Production answers only on `timesifier.com`. `www` is redirected to it with status 308, and any other host gets 404 (`workers/canonical-host.ts`).

The reason is a Cloudflare behaviour: with `preview_urls` on, which pull-request previews need, every uploaded version of the Worker also gets its own address, `<version>-timesifier.ayoinc.workers.dev`, bound to the production database. Without the host check an old version with a fixed bug would stay reachable there for good. The smoke test after each deploy asks the new version's address for the home page and fails unless it gets 404.

The Worker knows it is production from the variable `ENVIRONMENT` in `wrangler.jsonc`; a missing or unknown value counts as production. Previews set it to `preview` and answer on their own addresses. A loopback host (`localhost`, `127.0.0.1`) is always served, which is what local development and the browser tests use; Cloudflare never routes such a host to the Worker.

Plain HTTP is redirected to HTTPS by the zone's "Always Use HTTPS" setting, which is on. The smoke test checks it.

### Headers

Every response from the Worker carries:

| Header                      | Value              |
| --------------------------- | ------------------ |
| `Strict-Transport-Security` | `max-age=63072000` |
| `X-Content-Type-Options`    | `nosniff`          |

A response that is not HTML (a redirect, a refusal, data) also carries `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, so a response opened on its own can load and run nothing.

A response whose content type is HTML, including error pages, also carries:

| Header                       | Value                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`    | See below                                                                                                                                                                                            |
| `Referrer-Policy`            | `strict-origin-when-cross-origin`                                                                                                                                                                    |
| `X-Frame-Options`            | `DENY`                                                                                                                                                                                               |
| `Cross-Origin-Opener-Policy` | `same-origin`                                                                                                                                                                                        |
| `Permissions-Policy`         | Every feature in the list in `workers/security-headers.ts` is denied with `=()`. Passkeys are allowed for our own origin: `publickey-credentials-get=(self)`, `publickey-credentials-create=(self)`. |

Files in `public/` and the built scripts and styles are served by Workers Static Assets before the Worker runs, so the Worker cannot add headers to them. `public/_headers` gives them `X-Content-Type-Options: nosniff`, the same HSTS value and the same "nothing loads" policy. That policy matters when a file is opened directly; it does not affect a page that loads the file.

**HSTS has no `includeSubDomains` and no `preload`.** Other subdomains of `timesifier.com` belong to other services (see `docs/architecture.md`). `includeSubDomains` would make browsers refuse plain HTTP on every one of them, and `preload` requires it and is slow to undo. Without it the header applies only to the host that sent it.

### Content Security Policy

```
default-src 'self';
script-src 'self' 'nonce-<random>';
style-src 'self' 'sha256-<usePress>' 'sha256-<usePreventScroll>';
img-src 'self' data:;
font-src 'self';
connect-src 'self';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
object-src 'none'
```

- The nonce is 128 random bits from Web Crypto, new for every request. The Worker creates it, passes it to `app/entry.server.tsx` through the router context, and writes the header. `ServerRouter` and React put it on every inline script they emit.
- There is no `unsafe-inline`, no `unsafe-eval` and no `strict-dynamic`. Scripts are our own files, allowed by `'self'`; only the inline scripts need the nonce.
- **`style-src` allows our own stylesheets and two `<style>` elements by hash, nothing else.** A `style` attribute, and any other `<style>` element, is ignored by the browser, so the page looks wrong without failing. React's `style` prop becomes a `style` attribute in the server-rendered HTML, so it is blocked on first paint. Style with classes and design tokens. A value that must be computed at run time is set from script after hydration through the CSSOM (`element.style.setProperty(…)`), which the policy allows. Check what a library renders on the server before adding it.
- Add a new source only with the card that needs it, and record it here.

### The two hashes

React Aria (TS-005) inserts two `<style>` elements from script. Each has a fixed text, so each is allowed by the SHA-256 hash of that text. A hash allows one exact text: it lets in no other inline style, and no `style` attribute.

| Hash                                                  | Inserted by                                                    | Text                                                                               | What it does                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=` | `usePress`, once, when the first pressable element mounts      | `@layer { [data-react-aria-pressable] { touch-action: pan-x pan-y pinch-zoom; } }` | Stops the browser waiting for a double tap before it reports a press.                                                          |
| `sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg=` | `usePreventScroll`, on iOS only, while a modal overlay is open | `@layer { * { overscroll-behavior: contain; } }`                                   | Keeps the page from scrolling behind an open dialog, sheet, select or menu. Other browsers get `overflow: hidden` on the page. |

The table shows each text on one line; the hashed text has the line breaks the library writes.

- The list is `REACT_ARIA_STYLE_HASHES` in `workers/security-headers.ts`.
- **Re-derive it on every React Aria upgrade.** `test/node/react-aria-styles.test.ts` reads the installed `react-aria`, `react-aria-components` and `react-stately`, finds every module that creates a `<style>` element, takes each text and hashes it. It fails when the library inserts a text the policy does not allow, when the policy allows a text the library no longer inserts, or when a new module starts creating `<style>` elements, and its message gives the hash to use. Update the list, `test/browser-policy.test.ts` and this table together.
- The browser tests are the second check: every one fails on a `securitypolicyviolation` event, in Chromium and, for the overlays, in WebKit on the iOS path (`e2e/fixtures.ts`, `e2e/overlays-ios.spec.ts`).

### What components do to live under the policy

- **No `style` attribute reaches the server-rendered HTML.** React Aria's Checkbox, Switch and Select components hide a native input or select with a `style` attribute. Ours are built on React Aria's hooks instead and hide that element with a class (`app/components/Checkbox.tsx`, `Switch.tsx`, `Select.tsx`). The reasoning and the measurements are in `docs/decisions.md`, entry 6.
- **Overlays are positioned from script.** A menu, a select list, a tooltip, a dialog and a sheet render only in the browser, after hydration, and React sets their position through the CSSOM. They are never in the server's HTML.
- **Before using another React Aria component, render it with `renderToString` and look for `style=`.** The date and time components carry `style` attributes and will need the hooks.

### Relaxed under `pnpm dev`

Only when `import.meta.env.DEV` is true:

- `style-src` is `'self' 'unsafe-inline'`, without the two hashes. The Vite dev server injects stylesheets as `<style>` elements so it can hot-reload them, and a browser ignores `'unsafe-inline'` in a directive that also carries a hash.

Nothing else changes. The hot-reload WebSocket is same-origin and allowed by `connect-src 'self'`. Tests run with `DEV` false and check the policy that ships; the browser tests run against a production build for the same reason.

### Origin check

Before the framework sees a request, the Worker answers 403 to a `POST`, `PUT`, `PATCH` or `DELETE`, and to a WebSocket handshake (a `GET` with `Upgrade: websocket`), when:

- `Origin` is present and is not the origin of the request's own URL, or
- `Sec-Fetch-Site` is present and is neither `same-origin` nor `none`.

A request with neither header is let through: browsers send `Origin` on these methods, so it is not from a browser and cannot carry a person's session by forgery. Session cookies are `SameSite=Lax` as a second layer. `GET`, `HEAD` and `OPTIONS` are never blocked, so they must never change state.

React Router has its own check: it answers 400 to a page or data request with a state-changing method whose `Origin` is not the request's host. It does not cover resource routes. The Worker's check covers every route.

### Input validation

Every action begins with `parseRequest(request, schema)` from `app/lib/validate.ts`. It reads form data or JSON, checks it against a Zod 4 schema and returns the typed result. When the body cannot be read or does not match, it throws a 400 response whose body is `{ errors: { form: string[], fields: Record<string, string[]> } }`. The response holds messages and field names, never the submitted values; a custom message in a schema must not include the input either.

A body larger than 64 KiB is answered 413 and is not read past the limit; an action that accepts a file passes a larger `maxBytes`. A form field named `__proto__` is an ordinary field: it cannot change the parsed object's prototype.

`test/action-validation.test.ts` finds every route that exports an `action` and fails until that route has a malformed request listed there that receives 400.

### What TS-008 must add for Turnstile

Turnstile loads a script from Cloudflare and runs in a frame. On the pages that show the widget, the policy needs:

- `script-src`: `https://challenges.cloudflare.com`, and the page's nonce on the Turnstile `<script>` element. The nonce alone is not enough: without `strict-dynamic`, the scripts Turnstile loads for itself need the host to be listed.
- `frame-src https://challenges.cloudflare.com` (today frames fall back to `default-src 'self'`).

Checked on 2026-11-11 against <https://developers.cloudflare.com/turnstile/reference/content-security-policy/>. `connect-src 'self'` is already enough for pre-clearance mode. The pages that show the widget confirm it puts no inline style on our page, and add a test. The token is verified on the server by Better Auth before a code is created; see "Authentication" above.

## Known gaps and accepted risks

From the review of the foundation on 2026-11-11 (card TS-026). Each is open on purpose, with what would close it.

| Gap                                                                                                                                                                                                                                        | Why it is accepted for now                                                                                                                        | What closes it                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A pull request opened from a branch of this repository runs with the pipeline's Cloudflare token, and the pull request controls the Wrangler configuration, the migrations and the workflow.                                               | The owner is the only person who can push a branch. Pull requests from forks get no secrets.                                                      | Branch protection on `main` and the token in a GitHub environment limited to `main`; both need a paid GitHub plan for a private repository. Owner's decision (TS-002). |
| Install and build run in the same job as the Wrangler steps.                                                                                                                                                                               | pnpm runs install scripts only for `esbuild` and `workerd`, listed in `pnpm-workspace.yaml`, and the token is passed to the Wrangler steps alone. | Build in a job without secrets and hand the result to a job that only runs Wrangler.                                                                                   |
| Versions of the Worker uploaded before TS-026 still answer on their workers.dev addresses.                                                                                                                                                 | They contain no sign-in and read no data.                                                                                                         | Deleting those versions, or Cloudflare Access on version addresses.                                                                                                    |
| Cloudflare injects its Web Analytics script, from `static.cloudflareinsights.com`, into every page (the zone's RUM setting is on). It carries the page's nonce, so the policy allows it, and it reports to `/cdn-cgi/rum` on our own host. | It is a zone-wide setting that other services on this zone may rely on.                                                                           | The owner turns it off for the zone, or excludes this host. Until then the pages do make one request to another origin.                                                |
| The zone accepts TLS 1.0 (minimum TLS version is 1.0).                                                                                                                                                                                     | Zone-wide setting shared with other services.                                                                                                     | The owner raises the minimum to 1.2.                                                                                                                                   |

## Secrets

Secrets are stored once, in a place built for them, and read directly from there.

| Where the code runs             | Where the secret lives                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Local development               | `.dev.vars` in the project folder, ignored by git, readable only by the owner (`chmod 600`) |
| Deployed Worker                 | Wrangler secrets                                                                            |
| Pipeline                        | GitHub Actions secrets                                                                      |
| Wrangler on the owner's machine | Wrangler's own login                                                                        |

No command fetches a secret from a password manager each time it runs. A new secret is added to all the places it is needed in the same change, and its name (never its value) is listed in `.dev.vars.example`.

| Name                   | What it is                                    | Production                   | Previews                                                           | Local and tests                                          |
| ---------------------- | --------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | Secret. Signs session cookies                 | Wrangler secret              | Secret in the previews' base configuration, a different value      | `.dev.vars`; tests use a throwaway value in their config |
| `TURNSTILE_SECRET_KEY` | Secret. Verifies Turnstile tokens             | Wrangler secret              | Cloudflare's published test key, in `wrangler.jsonc`: not a secret | The same published test key                              |
| `TURNSTILE_SITE_KEY`   | Public. The widget's key, sent to the browser | Variable in `wrangler.jsonc` | Cloudflare's published test key, in `wrangler.jsonc`               | The same published test key                              |

`wrangler.jsonc` lists the two secrets as required, so a deploy fails while either is missing, and the Worker refuses to build Better Auth without them. Changing `BETTER_AUTH_SECRET` signs everyone out.

## Rules for anyone changing the code, human or AI

- Keep secret values out of code, logs, commit messages, pull requests and chat.
- Production data changes go through migrations in the pipeline.
- DNS changes on `timesifier.com` are limited to the Worker's custom domains and the application's one email subdomain. The zone carries live email for other services; see `docs/architecture.md`.
- A new dependency needs a reason in the pull request: what it does, who maintains it, why the platform or an existing dependency cannot do it.
- Report a suspected vulnerability to the owner privately before opening an issue.
