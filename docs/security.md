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
| Input         | Every loader and action validates its input against a schema.                                                                                             | TS-010 |
| Browser       | Content Security Policy with nonces, HSTS, `frame-ancestors 'none'`, Referrer-Policy, Permissions-Policy. State-changing requests are checked for origin. | TS-010 |
| Secrets       | None in the repository. A secret scan runs on every pull request.                                                                                         | TS-002 |
| Supply chain  | Frozen lockfile, dependency audit, third-party actions pinned to a commit, workflows with read-only permissions by default                                | TS-002 |
| Deployment    | The pipeline's Cloudflare token can reach this Worker, this database and this zone, nothing else.                                                         | TS-003 |
| AI            | Text from users is data, never instructions. Output is a suggestion a person accepts. Spend is capped.                                                    | TS-015 |
| Audit         | Sign-in, role changes, exports and deletions are recorded.                                                                                                | TS-020 |
| Data rights   | A person can export their data and delete their account. Retention is written down.                                                                       | TS-021 |
| Logging       | Structured logs with no secrets and no entry text.                                                                                                        | TS-022 |
| Recovery      | The database can be restored to a point in time; one restore has been rehearsed.                                                                          | TS-022 |
| Review        | A threat model covers each part of the system; high findings are fixed.                                                                                   | TS-019 |

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
