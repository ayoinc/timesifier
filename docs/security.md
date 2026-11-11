# Security

The baseline every change is held to. Each control names the card that puts it in place, and that card's acceptance criteria prove it.

Timesifier holds personal data: who worked on what, and when. The owner is in the UK, so UK GDPR applies from the first real user.

## Controls

| Area          | Control                                                                                                                                                                                                                                           | Card   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Identity      | Passkeys first, email as the fallback: a one-time code sent to the address, which is also how the address is first proved. No passwords. Optional two-factor is not built yet.                                                                    | TS-008 |
| Sessions      | Cookie is `HttpOnly`, `Secure`, `SameSite=Lax` with the `__Host-` prefix. A person can end all their sessions, and that takes effect on the next request.                                                                                         | TS-008 |
| Abuse         | Sending a sign-in code, signing in with a code and signing in with a passkey each allow one client 10 requests a minute; the 11th gets 429. The request that sends a code, which is how an account starts, is checked by Turnstile on the server. | TS-008 |
| Authorisation | Denied unless allowed. A person's role is read from the database on every request and decides what they may do. An organisation a person does not belong to answers them exactly as one that does not exist. See "Organisations and roles".       | TS-009 |
| Tenancy       | Customer data is reached only through the organisation-scoped data layer. A test proves one organisation cannot read another's rows. The organisation of a request comes from the request, never from the session (TS-009).                       | TS-007 |
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

- **Email code.** A person asks for a code for an address; the request carries a Turnstile token. An eight-digit code is emailed. Sending it back, from the browser that asked, signs the person in and, the first time, creates their account with the address marked verified. The answer to "send me a code" is the same whether or not the address has an account.
- **Passkey.** A signed-in person can add a passkey; after that they sign in with it, and the email code remains the fallback. The relying party is the host the request was made to, and the authenticator must verify the person.
- **Sign-out** ends the session the cookie belongs to. **Ending all sessions** ends every session the person has, this one included.
- There are no passwords. Better Auth's password endpoints, like every endpoint the application does not offer, answer 404 (see "Endpoints").

### What is stored

| Table           | Holds                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`         | Name, email address, whether the address is verified                                                                                                                                                              |
| `sessions`      | The session token, its expiry, the client address and user agent it was created from                                                                                                                              |
| `verifications` | A keyed hash of each emailed code with its count of attempts, for five minutes; the challenge of a passkey ceremony, for five minutes; one row for each use of a cap (see "Abuse"), until that use stops counting |
| `passkeys`      | The public key, credential id and counter of each passkey. The private key never leaves the person's device                                                                                                       |
| `rate_limits`   | One counter per client address and sign-in path                                                                                                                                                                   |

A code is eight digits, works once, and stops working after three wrong attempts or five minutes. It is stored as an HMAC-SHA-256 under `BETTER_AUTH_SECRET` (`app/auth/keyed-hash.server.ts`), never as the code and never as a plain hash: there are few enough codes to try them all against a plain hash, so only the key makes a copy of the database useless on its own. The session cookie holds the token and a signature made with `BETTER_AUTH_SECRET`; the session itself is read from the database on every request, never from a copy in a cookie, so an ended session is refused at once.

### The cookie

`__Host-timesifier.session_token`, with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` and no `Domain`. The `__Host-` prefix makes the browser accept the cookie only over HTTPS and send it only to the exact host that set it. Better Auth has no option for this prefix yet; how it is configured, and what to do when one arrives, is in `docs/decisions.md` entry 8. Do not rewrite the `Set-Cookie` header in the Worker: Better Auth would stop recognising its own cookie.

### A code is used in the browser that asked for it

The answer to a request for a code sets a second cookie, `__Host-timesifier.sign_in_code`, with the same attributes. Its value is an expiry and an HMAC under `BETTER_AUTH_SECRET` of the lower-cased address and that expiry: it proves that this browser asked for a code for this address, holds no address, and cannot be made or altered without the secret. A request to sign in with a code is checked against it before the email-code plugin sees the request (`app/auth/sign-in-code.server.ts`):

- no cookie, or one made for another address or altered: the answer a wrong code gets, `400 {"code":"INVALID_OTP"}`, byte for byte, and the code's three attempts are untouched;
- a cookie whose five minutes are over: the answer an expired code gets, `400 {"code":"OTP_EXPIRED"}`. The browser keeps the cookie for an hour so that this, and not "wrong code", is what a late person is told.

So somebody who knows only an address cannot use up the attempts of a code its owner is about to type. Why, and what was given up, is in `docs/decisions.md` entry 22.

### Hosts

The hosts are per environment, from the variable `ENVIRONMENT` (`app/auth/hosts.ts`): production trusts `timesifier.com` alone, a preview trusts hosts ending `-timesifier.ayoinc.workers.dev`, and any other value, which is a developer's machine or a test, trusts `localhost` on any port. Better Auth takes the application's address, its trusted origins and the passkey relying party from the request only when the host is one of the environment's own. A request for any other host gets 404 from the mount before Better Auth sees it: no cookie is set and no session is read. Locally `ENVIRONMENT` is set in `.dev.vars`; a deployed Worker that lost the variable would answer no sign-in request at all.

No request can name a place to send the browser other than a path on its own origin: a `callbackURL`, `redirectTo`, `errorCallbackURL` or `newUserCallbackURL` that is anything else gets 403 (`app/auth/redirects.server.ts`).

### Endpoints

`app/auth/endpoints.ts` lists the 26 endpoints the application offers under `/api/auth`, each with its one method: asking for a code and signing in with it; the session, sign-out and ending all sessions; six for passkeys; and 15 for organisations. They are the ones a page calls and no other: an endpoint nothing calls is not offered, however harmless. Any other method or path gets 404 from the mount before Better Auth, its rate limit or the database sees the request, so an unknown path costs no read and no write. Better Auth registers 70 endpoints under this configuration, among them a health check, an error page of its own and one that sets a person's name and image; none of those is reachable. `test/auth/endpoints.test.ts` reads every endpoint from the installed library and fails when one is neither listed nor answered 404, so an upgrade cannot add one unnoticed. The two code requests take exactly their own fields: a code of any kind but `sign-in`, an image for a new account, or any field that is not listed gets 400. Signing in with a code may carry the name a person gave on the sign-up page, which is stored when the code creates their account: one line of at most 100 characters, with no control character and none that reverses the direction of text.

### Abuse

- **Rate limit.** Counted in D1 per client address and path. The address is `CF-Connecting-IP`, which Cloudflare sets and a client cannot forge; `X-Forwarded-For` is ignored. One client may ask for a code 3 times a minute and try to sign in, with a code or with a passkey, 10 times a minute; the next request gets 429. Asking for the options of a passkey sign-in, which anyone may do and which stores a challenge in `verifications` for five minutes each time, is allowed 30 times a minute: the sign-in page asks once each time it loads. The count starts again 60 seconds after the last request that was let through. The limit applies only to requests that arrive at `/api/auth/`: server code that calls Better Auth directly is not limited, so sign-in must never be offered through another route.
- **Codes per address.** An address is sent at most 5 codes in any hour, whoever asks and from wherever. The sixth request is answered exactly like a served one and nothing is issued or sent, so the cap tells nobody that an address has been asking. With three attempts a code, that is 15 guesses an hour against a hundred million codes. The count is kept in `verifications` under an HMAC of the address, not the address (`app/auth/quota.server.ts`), and a request that the rate limit or Turnstile refused is not counted.
- **Turnstile.** The token is sent in the `x-captcha-response` header and verified with Cloudflare before a code is created. A missing token gets 400 and a rejected one 403; neither creates nor sends a code. The hostname in Cloudflare's answer, the site the token was solved on, must be the host of the request itself, in production and on a preview (`app/auth/turnstile.server.ts`, through the captcha plugin's `allowedHostnames`). The production widget is registered at Cloudflare for `timesifier.com` only, so this is a second layer, not the only one. Cloudflare's published test secrets always answer with the hostname `example.com`: that hostname is accepted when the configured secret is one of those test secrets, and never otherwise. Passkey sign-in is not behind Turnstile: it sends no email and cannot create an account.
- **Passkeys.** The authenticator must verify the person, with a PIN or a fingerprint, to add a passkey and to sign in with one; an answer without that is refused. A credential id belongs to one passkey. A request to add a passkey whose id some passkey already has, which no authenticator produces, is the caller's mistake: `400 {"code":"PASSKEY_ALREADY_REGISTERED"}`, nothing stored and nothing logged as an error. `passkeys.credential_id` also has a unique index, for two such requests at once.

### The guard on `/app`

Everything under `/app` needs a session. The layout route `app/routes/app/layout.tsx` exports a `middleware` (`requireSession` in `app/routes/auth/session.server.ts`) that reads the session with `getSession`, from the database, before the loader or action of any route under it runs. Without a session that is still valid it answers with a redirect to `/sign-in?next=<the address asked for>`: a 302 for a page, and the framework's encoding of the same redirect for a data request. An action behind the guard does not run. The layout also exports a `loader`, so that every move between destinations asks the server and passes the guard; an ended session is turned away on the next move, not only on the next page load.

- **A new route under the layout is covered by being there.** `test/auth/guard.test.ts` reads every route whose address is `/app` or below it from the built route configuration and requests each one without a session: the page, its data, and a form posted to each route that has an action. A route placed under `/app` but outside the layout fails that test.
- **Loaders and actions under `/app`** read the signed-in person from the router context (`signedInContext`), which the guard sets. They do not read the cookie again.
- **`next` is never trusted.** After sign-in a person goes to `next` only when it is a path on our own origin at or under `/app`; anything else, or nothing, gives `/app` (`safeNext` in `app/routes/auth/paths.ts`). The value is parsed as a browser would follow it, so an address behind `//`, a backslash or `..` is judged by where it leads. The sign-in and sign-up pages send a person who already has a session to the same place.
- **The pages call Better Auth only through `/api/auth/`**, from the browser, where the rate limit and the Turnstile check act. Settings lists a person's passkeys from its loader by handing a request with the person's own cookie to the same handler. No message on either page says whether an address has an account.

### Email

`sendEmail` in `app/auth/email.server.ts` is the only code that touches the `EMAIL` binding. Every message comes from `Timesifier <no-reply@mail.timesifier.com>`, and `wrangler.jsonc` allows the binding that sender and no other. The code email is plain text and plain HTML with no link, image or tracking. Sending is handed to `waitUntil`, so how long it takes does not show in the response. A preview has no `EMAIL` binding and sends nothing; locally Wrangler simulates the binding and sends nothing either.

### Never logged

No log line carries an email address or any part of one, a code or its hash, a cookie or a session token. The email sender logs nothing about the recipient, and the error code of a failed send without its message. An error nobody expected, a statement D1 refused for one, is answered `500 {"code":"INTERNAL_SERVER_ERROR"}` and logged as its name and the endpoint's path, without the query string: Drizzle's message for such an error is the statement with its parameters. Better Auth's own logger is replaced by one that keeps the library's words up to the first colon and the name of any error it was handed (`app/auth/log.server.ts`), and `getSession` throws an error of its own in place of the library's, which carries the statement. `test/auth/email.test.ts` reads every line logged during a whole sign-in, and during a failed statement on each of three tables, and fails if one of those values appears.

Outside authentication the rule is held by `handleError` in `app/entry.server.tsx`, which React Router calls for every error it catches on the server, in a loader, an action, a middleware or while rendering. It writes the error's name and the path, with each parameter of the path written as its name (`/invitations/:id`), and never the message or the query string; a request the browser gave up on is not logged. `test/error-log.test.ts` holds it in place.

### The one action without `parseRequest`

`app/routes/api.auth.$.ts` hands the request to Better Auth untouched. Better Auth checks each endpoint's body against its own Zod schema and answers 400 for a body that is not JSON or does not match, and 415 for a content type other than JSON; reading the body first with `parseRequest` would consume it. `test/action-validation.test.ts` holds the 400 in place like any other action.

## Organisations and roles

Better Auth's organization plugin keeps organisations, memberships and invitations in our tables, and is configured in `app/auth/organisations.server.ts`. It is reached through the same mount, at `/api/auth/organization/*`. The tests in `test/organisations/` drive it through the Worker and hold what is written here in place. Teams, and roles made up at run time, are switched off.

### Roles

A member of an organisation is an owner, an admin or a member. The roles and what each may do are in `app/organisations/roles.ts`, which the plugin checks on the server for every request; nothing a browser sends decides it.

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

An organisation always has at least one owner: the last owner cannot leave, be removed or be demoted. A member holds exactly one role; a request that names a list of roles, or a role that is not one of the three, gets 400. Pending invitations are shown only to those who may invite, because an invitation's id is its link.

`test/organisations/permissions.test.ts` holds a copy of this table and has a trial through the real endpoint for each of its 27 cells; it fails when a cell has no trial or a trial contradicts its cell. Change the table here, in the test and in `roles.ts` together.

### The gate in front of the plugin

Every request to `/organization/*` passes one check of ours before the plugin sees it (`organisationRules` in `app/auth/organisations.server.ts`):

- **Only the endpoints we use exist.** The 15 listed in that file are answered; every other endpoint of the plugin gets 404, including the ones that set an "active organisation", check whether a slug is taken, look an organisation up by its slug or list the invitations sent to a person. An upgrade of Better Auth cannot add an endpoint unnoticed.
- **Input is exact.** Each endpoint has a strict Zod 4 schema. A missing field, a wrong type or a field that is not listed gets 400 and nothing is stored.
- **The organisation comes from the request.** Every endpoint that acts on an organisation must be given its id. The plugin records an "active organisation" on the session when a person creates or joins one; nothing reads it (`docs/decisions.md` entry 20).
- **"Not found" for anyone who is not a member.** The gate reads the person's membership through `organisationScope`. Without one the answer is `404 {"code":"ORGANIZATION_NOT_FOUND"}`, byte for byte the same whether the organisation does not exist or belongs to other people, and the plugin is not reached.

A signed-out request to one of the 15 gets 401 before its input is read.

### Creating an organisation

Any signed-in person whose email address is verified may create an organisation, and becomes its only member, as owner. A person may own at most 5 organisations; the next is refused with `403 {"code":"YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS"}`. Organisations a person only belongs to are not counted, which is why the plugin's own `organizationLimit` is not used: it counts every membership. The request carries a name and nothing else. A name is 1 to 80 characters, with no line break, no other control character and none that reverses the direction of text, because it is shown in pages and quoted in the invitation email.

The slug is derived from the name on the server (`app/organisations/slug.ts`): lowercase letters, digits and hyphens, 3 to 40 characters, no hyphen at either end. It is never `new`, `settings`, `api`, `auth`, `app`, `admin`, `www`, `invitations`, `sign-in` or `sign-up`. When the slug is taken or reserved the organisation gets the next free number instead of an error: `acme`, `acme-2`, `acme-3`. Renaming an organisation does not change its slug, and no request can set one.

### Invitations

- An owner or admin invites an email address as `admin` or `member`. Ownership is never given by invitation.
- An address that is already a member, or already has a pending invitation to the same organisation, is refused. There is no "send again": that would extend the invitation's life.
- An invitation works for exactly 7 days and once. Accepting it needs a session whose verified email address is the invited one, compared without regard to capitals.
- An invitation that does not exist, has been accepted, declined or cancelled, has expired, or was sent to somebody else gets one answer, `404 {"code":"INVITATION_NOT_FOUND"}`, whether the request reads, accepts or declines it. The id tells nobody but its recipient anything.
- An invitation stands on its sender's right to invite. Once the person who sent it is no longer an owner or admin of that organisation, because they were removed, made a member or left, it can be neither read nor accepted and gets the same 404. It can still be declined. Otherwise an admin about to be removed could invite an address of their own and return with it.
- Cancelling names the organisation as well as the invitation, and only a pending invitation of that organisation can be cancelled.
- The email is sent with `sendEmail`, from the application's one sender, as plain text and plain HTML with no image or other remote content. Its subject is the same for every invitation, "You are invited to join an organisation on Timesifier", and holds nothing a person chose: the message goes to somebody who never asked for it. Its one link is `https://<host>/invitations/<id>`, where the host is the one the invitation was made on, which `app/auth/hosts.ts` has already checked is ours. The organisation's name appears in the body alone, quoted in the text and escaped in the HTML.
- The id in the link is a UUID version 7 with 74 random bits. It is not the only thing needed: the session of the invited address is.

### "Not found" for pages

A page under `/app/<slug>/` calls `requireMembership(request, slug)` from `app/organisations/membership.server.ts`. It returns the organisation, the person's role and the person, read from the database on that request, or throws React Router's 404. The 404 is the same for a slug no organisation has, for an organisation the person does not belong to, and for a request with no session, and the same two queries run in the first two cases.

### Abuse

Creating an organisation and sending an invitation each allow one client 10 requests a minute; the 11th gets 429. They are counted by the limiter described under "Authentication", and like it they apply only to requests that arrive at `/api/auth/`. Two caps are per person and not per client: 5 organisations owned (above), and 20 invitations sent in any 24 hours across all of a person's organisations, after which the answer is `429 {"code":"TOO_MANY_INVITATIONS"}` and nothing is stored or sent. An invitation is counted when it is made; cancelling it or deleting its organisation gives nothing back, and an invitation refused for another reason is not counted. The plugin's own ceilings are left at their defaults: 100 members and 100 pending invitations for an organisation.

### What is stored

| Table           | Holds                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `organisations` | Name and slug                                                                                  |
| `memberships`   | Which person belongs to which organisation, and their role                                     |
| `invitations`   | The invited address, the role offered, who sent it, when it expires and what became of it      |
| `sessions`      | One more column, the plugin's "active organisation", which the plugin writes and nothing reads |

Deleting an organisation deletes its memberships and invitations with it.

### Never logged

No log line carries an email address or an invitation's id. `test/organisations/invitations.test.ts` reads every line logged while an invitation is sent, accepted and refused, and fails if one appears.

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
- Add a new source only with the card that needs it, and record it here. One has been added, for two pages only: see "Turnstile on the page".

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

### The colour-scheme cookie

`__Host-color-scheme` holds the word `light` or `dark`, the scheme a person chose in Settings, with `Secure`, `SameSite=Lax`, `Path=/`, no `Domain` and a life of one year; it is not `HttpOnly` because it identifies nobody and grants nothing, so there is nothing for a script to steal. The server writes it only from the validated Settings form and renders from it only one of those two words: any other value is ignored (`app/shell/color-scheme.server.ts`, `test/color-scheme.test.ts`).

### Turnstile on the page

Turnstile loads a script from Cloudflare and runs in a frame. Two pages show the widget, `/sign-in` and `/sign-up`, and only their policy has the two sources it needs:

```
script-src 'self' 'nonce-<random>' https://challenges.cloudflare.com;
frame-src https://challenges.cloudflare.com;
```

Every other directive on those two pages, and the whole policy of every other page, is the one above.

- **How a page gets the addition.** The route exports `headers` and sets `Timesifier-Policy-Addition: turnstile` on its own response. `withSecurityHeaders` in `workers/security-headers.ts` reads the header, removes it, and builds the policy with the addition. The header never reaches a browser, a request cannot set it, a value other than `turnstile` adds nothing, and a response that is not HTML gets the "nothing loads" policy whatever it names. A page that does not ask keeps the base policy. To give another page the widget, export the same `headers` from its route and add the route to the tests named below.
- **Why the host is listed.** The nonce is on the `<script>` element that loads `https://challenges.cloudflare.com/turnstile/v0/api.js`, and the policy has no `strict-dynamic`, so the scripts Turnstile then loads for itself need the host. Without `frame-src`, a frame falls back to `default-src 'self'`.
- **Moving between pages loads the page.** A document keeps the policy it was loaded with, so the pages with the addition and the pages without it are never reached from one another by a move inside the page: the links between them are plain links, the guard redirects with `redirectDocument`, and the pages leave with `location.assign`.
- **Where the widget runs.** `app/routes/auth/RobotCheck.tsx` renders it explicitly, on the views that send a code and nowhere else: the first view of `/sign-in` offers a passkey and loads nothing of Turnstile's. The site key comes from `TURNSTILE_SITE_KEY` through the route's loader. The token goes to the server in the `x-captcha-response` header; the widget is told to add no form field.
- **What the widget does to our document.** Measured in Chromium on 2026-11-11: it adds one `div` to the element it is given, with a closed shadow root that holds its frame, and sizes the frame through the CSSOM, which the policy allows. It adds no `<style>` element and no `style` attribute to our markup, and raises no violation. `e2e/auth-turnstile.spec.ts` holds this in place, and the fixture every browser test shares fails any test on a violation.

Checked on 2026-11-11 against <https://developers.cloudflare.com/turnstile/reference/content-security-policy/>. `connect-src 'self'` is already enough for pre-clearance mode. Tests: `test/browser-policy.test.ts`, "the Turnstile addition to the policy"; `e2e/auth-turnstile.spec.ts`. The token is verified on the server by Better Auth before a code is created; see "Authentication" above.

## Known gaps and accepted risks

From the review of the foundation on 2026-11-11 (card TS-026) and the review of authentication and organisations of the same day (card TS-027). Each is open on purpose, with what would close it.

| Gap                                                                                                                                                                                                                                                                                                                                                                             | Why it is accepted for now                                                                                                                                                                                                                     | What closes it                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A pull request opened from a branch of this repository runs with the pipeline's Cloudflare token, and the pull request controls the Wrangler configuration, the migrations and the workflow.                                                                                                                                                                                    | The owner is the only person who can push a branch. Pull requests from forks get no secrets.                                                                                                                                                   | Branch protection on `main` and the token in a GitHub environment limited to `main`; both need a paid GitHub plan for a private repository. Owner's decision (TS-002). |
| Install and build run in the same job as the Wrangler steps.                                                                                                                                                                                                                                                                                                                    | pnpm runs install scripts only for `esbuild` and `workerd`, listed in `pnpm-workspace.yaml`, and the token is passed to the Wrangler steps alone.                                                                                              | Build in a job without secrets and hand the result to a job that only runs Wrangler.                                                                                   |
| Versions of the Worker uploaded before TS-026 still answer on their workers.dev addresses.                                                                                                                                                                                                                                                                                      | They contain no sign-in and read no data.                                                                                                                                                                                                      | Deleting those versions, or Cloudflare Access on version addresses.                                                                                                    |
| Cloudflare injects its Web Analytics script, from `static.cloudflareinsights.com`, into every page (the zone's RUM setting is on). It carries the page's nonce, so the policy allows it, and it reports to `/cdn-cgi/rum` on our own host.                                                                                                                                      | It is a zone-wide setting that other services on this zone may rely on.                                                                                                                                                                        | The owner turns it off for the zone, or excludes this host. Until then the pages do make one request to another origin.                                                |
| The zone accepts TLS 1.0 (minimum TLS version is 1.0).                                                                                                                                                                                                                                                                                                                          | Zone-wide setting shared with other services.                                                                                                                                                                                                  | The owner raises the minimum to 1.2.                                                                                                                                   |
| TS-009. Two owners who demote or remove each other, or both leave, in the same instant could leave an organisation with no owner: the plugin counts the owners and then writes, in separate statements.                                                                                                                                                                         | It needs two owners acting against each other within milliseconds.                                                                                                                                                                             | A database trigger, or a single conditional statement, that refuses to remove or demote the last owner.                                                                |
| TS-009. Two organisations of the same name created in the same instant can be given the same slug; the unique index then refuses the second, which gets a server error instead of the next number.                                                                                                                                                                              | Nothing wrong is stored, and trying again succeeds.                                                                                                                                                                                            | Retrying the insert with the next number when the index refuses it.                                                                                                    |
| TS-009. A person who creates an organisation and is given `acme-2` learns that some organisation has the slug `acme`.                                                                                                                                                                                                                                                           | It follows from giving a number instead of an error. It says nothing about that organisation, and creation is limited to 10 a minute.                                                                                                          | Random slugs, which would make addresses unreadable. Not planned.                                                                                                      |
| TS-027. Somebody who knows a person's address can still keep that person from signing in with a code, in two ways. Asking for a code replaces the one the person is about to type; and five requests use up the address's codes for an hour. Each request costs the attacker a Turnstile token, and no more than three a minute from one client.                                | A code per requester is not something the email-code plugin offers, and without the cap an address can be guessed at without limit, which is worse. Guessing itself no longer locks anyone out: it needs the cookie of the browser that asked. | A passkey: sign-in with one needs no code, so the pages offer one straight after the first sign-in. A person with only email stays exposed until then.                 |
| TS-027. On a preview Turnstile passes every request and no mail is sent, so the cap of five codes an hour and 15 guesses is the only bound on guessing a code for an address there.                                                                                                                                                                                             | A preview's database holds test data only and is separate from production's.                                                                                                                                                                   | A real Turnstile widget for previews, or Cloudflare Access in front of them.                                                                                           |
| TS-027. The cap on organisations owned is a count followed by an insert, so requests sent in the same instant can go over five. The cap on invitations is one statement and cannot be passed this way.                                                                                                                                                                          | The rate limit allows one client ten creations a minute, so the excess is small, and an organisation alone sends nothing: invitations are what the cap protects, and that count is exact.                                                      | Taking a use of a quota before the organisation is created, as invitations do, and giving it back on deletion.                                                         |
| TS-027, unconfirmed. Workers Logs is on for every request (`wrangler.jsonc`), and Cloudflare's own invocation log records each request's URL. `/invitations/<id>` and `/api/auth/organization/get-invitation?id=<id>` would put an invitation's id there, which "Never logged" says does not happen in lines the application writes. Nobody on this card could read those logs. | The id alone opens nothing: the session of the invited address is needed as well. Reading logs needs access to the Cloudflare account.                                                                                                         | The owner looks at one invocation record. If the URL is there: carry the id in a POST body, or turn invocation logs off and keep the application's own lines.          |

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
