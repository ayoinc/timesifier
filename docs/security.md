# Security

The baseline every change is held to. Each control names the card that puts it in place, and that card's acceptance criteria prove it.

Timesifier holds personal data: who worked on what, and when. The owner is in the UK, so UK GDPR applies from the first real user.

## Controls

| Area          | Control                                                                                                                                                   | Card   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Identity      | Passkeys first, email as the fallback, optional two-factor                                                                                                | TS-008 |
| Sessions      | Cookie is `HttpOnly`, `Secure`, `SameSite=Lax` with the `__Host-` prefix. A person can end all their sessions.                                            | TS-008 |
| Abuse         | Sign-in and sign-up are rate limited. Sign-up is checked by Turnstile on the server.                                                                      | TS-008 |
| Authorisation | Denied unless allowed. Roles are checked on the server for every action.                                                                                  | TS-009 |
| Tenancy       | Customer data is reached only through the organisation-scoped data layer. A test proves one organisation cannot read another's rows.                      | TS-007 |
| Input         | Every loader and action validates its input against a schema. Every action starts with `parseRequest`, which answers 400 when the body does not match.    | TS-010 |
| Browser       | Content Security Policy with nonces, HSTS, `frame-ancestors 'none'`, Referrer-Policy, Permissions-Policy. State-changing requests are checked for origin. | TS-010 |
| Secrets       | None in the repository. A secret scan runs on every pull request.                                                                                         | TS-002 |
| Supply chain  | Frozen lockfile, dependency audit, third-party actions pinned to a commit, workflows with read-only permissions by default                                | TS-002 |
| Deployment    | The pipeline's token reaches this Worker, this zone's Worker routes and the account's D1 databases. Scope and expiry: `docs/architecture.md`.             | TS-003 |
| AI            | Text from users is data, never instructions. Output is a suggestion a person accepts. Spend is capped.                                                    | TS-015 |
| Audit         | Sign-in, role changes, exports and deletions are recorded.                                                                                                | TS-020 |
| Data rights   | A person can export their data and delete their account. Retention is written down.                                                                       | TS-021 |
| Logging       | Structured logs with no secrets and no entry text.                                                                                                        | TS-022 |
| Recovery      | The database can be restored to a point in time; one restore has been rehearsed.                                                                          | TS-022 |
| Review        | A threat model covers each part of the system; high findings are fixed.                                                                                   | TS-019 |

## Browser policy

Set by the Worker in `workers/app.ts` on every response it produces. The tests in `test/browser-policy.test.ts` hold it in place.

### Headers

Every response from the Worker carries:

| Header                      | Value              |
| --------------------------- | ------------------ |
| `Strict-Transport-Security` | `max-age=63072000` |
| `X-Content-Type-Options`    | `nosniff`          |

A response whose content type is HTML, including error pages, also carries:

| Header                       | Value                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`    | See below                                                                                                                                                                                            |
| `Referrer-Policy`            | `strict-origin-when-cross-origin`                                                                                                                                                                    |
| `X-Frame-Options`            | `DENY`                                                                                                                                                                                               |
| `Cross-Origin-Opener-Policy` | `same-origin`                                                                                                                                                                                        |
| `Permissions-Policy`         | Every feature in the list in `workers/security-headers.ts` is denied with `=()`. Passkeys are allowed for our own origin: `publickey-credentials-get=(self)`, `publickey-credentials-create=(self)`. |

Files in `public/` and the built scripts and styles are served by Workers Static Assets before the Worker runs, so the Worker cannot add headers to them. `public/_headers` gives them `X-Content-Type-Options: nosniff` and the same HSTS value.

**HSTS has no `includeSubDomains` and no `preload`.** Other subdomains of `timesifier.com` belong to other services (see `docs/architecture.md`). `includeSubDomains` would make browsers refuse plain HTTP on every one of them, and `preload` requires it and is slow to undo. Without it the header applies only to the host that sent it.

### Content Security Policy

```
default-src 'self';
script-src 'self' 'nonce-<random>';
style-src 'self';
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
- **`style-src 'self'` means no `style` attribute and no `<style>` element in rendered markup.** The browser ignores them, so the page looks wrong without failing. React's `style` prop becomes a `style` attribute in the server-rendered HTML, so it is blocked on first paint. Style with classes and design tokens. A value that must be computed at run time is set from script after hydration through the CSSOM (`element.style.setProperty(…)`), which the policy allows. Check what a library renders on the server before adding it.
- Add a new source only with the card that needs it, and record it here.

### Relaxed under `pnpm dev`

Only when `import.meta.env.DEV` is true:

- `style-src` gains `'unsafe-inline'`. The Vite dev server injects stylesheets as `<style>` elements so it can hot-reload them.

Nothing else changes. The hot-reload WebSocket is same-origin and allowed by `connect-src 'self'`. Tests run with `DEV` false and check the policy that ships.

### Origin check

Before the framework sees a request, the Worker answers 403 to a `POST`, `PUT`, `PATCH` or `DELETE` when:

- `Origin` is present and is not the origin of the request's own URL, or
- `Sec-Fetch-Site` is present and is neither `same-origin` nor `none`.

A request with neither header is let through: browsers send `Origin` on these methods, so it is not from a browser and cannot carry a person's session by forgery. Session cookies are `SameSite=Lax` as a second layer. `GET`, `HEAD` and `OPTIONS` are never blocked, so they must never change state.

React Router has its own check: it answers 400 to a page or data request with a state-changing method whose `Origin` is not the request's host. It does not cover resource routes. The Worker's check covers every route.

### Input validation

Every action begins with `parseRequest(request, schema)` from `app/lib/validate.ts`. It reads form data or JSON, checks it against a Zod 4 schema and returns the typed result. When the body cannot be read or does not match, it throws a 400 response whose body is `{ errors: { form: string[], fields: Record<string, string[]> } }`. The response holds messages and field names, never the submitted values; a custom message in a schema must not include the input either.

`test/action-validation.test.ts` finds every route that exports an `action` and fails until that route has a malformed request listed there that receives 400.

### What TS-008 must add for Turnstile

Turnstile loads a script from Cloudflare and runs in a frame. On the pages that show the widget, the policy needs:

- `script-src`: `https://challenges.cloudflare.com`, and the page's nonce on the Turnstile `<script>` element. The nonce alone is not enough: without `strict-dynamic`, the scripts Turnstile loads for itself need the host to be listed.
- `frame-src https://challenges.cloudflare.com` (today frames fall back to `default-src 'self'`).

Checked on 2026-11-11 against <https://developers.cloudflare.com/turnstile/reference/content-security-policy/>. `connect-src 'self'` is already enough for pre-clearance mode. TS-008 confirms the widget puts no inline style on our page, and adds a test for the pages that show it. The token is verified on the server, in the action, after `parseRequest`.

## Secrets

Secrets are stored once, in a place built for them, and read directly from there.

| Where the code runs             | Where the secret lives                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Local development               | `.dev.vars` in the project folder, ignored by git, readable only by the owner (`chmod 600`) |
| Deployed Worker                 | Wrangler secrets                                                                            |
| Pipeline                        | GitHub Actions secrets                                                                      |
| Wrangler on the owner's machine | Wrangler's own login                                                                        |

No command fetches a secret from a password manager each time it runs. A new secret is added to all the places it is needed in the same change, and its name (never its value) is listed in `.dev.vars.example`.

## Rules for anyone changing the code, human or AI

- Keep secret values out of code, logs, commit messages, pull requests and chat.
- Production data changes go through migrations in the pipeline.
- DNS changes on `timesifier.com` are limited to the Worker's custom domains and the application's one email subdomain. The zone carries live email for other services; see `docs/architecture.md`.
- A new dependency needs a reason in the pull request: what it does, who maintains it, why the platform or an existing dependency cannot do it.
- Report a suspected vulnerability to the owner privately before opening an issue.
