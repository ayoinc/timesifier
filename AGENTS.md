# Timesifier

A productivity and time platform on Cloudflare Workers. The documents and the board are the source of truth.

## How work flows

`docs/ways-of-working.md` holds the one procedure: the roles, how a card moves, and the Definition of Done. Read "Roles" first; it says which cards an assistant does not build ahead.

## Read before you act

- Changing a route, binding, table or deploy step: `docs/architecture.md`
- Building or styling any interface: `docs/design-system.md`
- Touching sign-in, sessions, customer data, secrets, headers, AI prompts or dependencies: `docs/security.md`
- Unsure what a feature is for: `docs/product.md`
- About to choose a library or pattern: `docs/decisions.md`. Settled choices stay settled; a new choice gets a new entry.
- Writing a route, a loader or an action: the React Router skill in `.agents/skills/react-router`

## Rules no config file states

- Every runtime service is a Cloudflare product.
- Customer data is reached through the organisation-scoped data layer: `organisationScope` in `app/db/`.
- Components take colour, size and motion from design tokens.
- Secrets live in `.dev.vars` locally and in Wrangler secrets when deployed.
- Nothing that belongs to one deployment is committed: no domain, database id, key or address. The Worker reads it from a variable, the pipeline from a repository variable, and `docs/security.md`, "Secrets", lists each one. A value that is missing fails the request or the deploy; it never has a default.
- `timesifier.com` carries live email records for other services. DNS changes are limited to the Worker's custom domains and the application's one email subdomain.
- Cloudflare's APIs change quickly: check the current documentation before using one, and trust the installed versions over memory.
