# Timesifier

A productivity and time platform on Cloudflare Workers. The documents and the board are the source of truth; the application code starts with card TS-001.

## How work flows

1. Take the top card in **Ready** in `BOARD.md`. One card is in progress at a time.
2. Work on a branch named after the card, for example `ts-012-timer`.
3. A card is done when every acceptance criterion is ticked with its evidence (a command and its result, a test name, or a URL) and the Definition of Done in `docs/ways-of-working.md` holds.
4. Move the card and date it in the same pull request.

## Read before you act

- Changing a route, binding, table or deploy step: `docs/architecture.md`
- Building or styling any interface: `docs/design-system.md`
- Touching sign-in, sessions, customer data, secrets, headers, AI prompts or dependencies: `docs/security.md`
- Unsure what a feature is for: `docs/product.md`
- About to choose a library or pattern: `docs/decisions.md`. Settled choices stay settled; a new choice gets a new entry.

## Rules no config file states

- Every runtime service is a Cloudflare product.
- Customer data is reached through the organisation-scoped data layer.
- Components take colour, size and motion from design tokens.
- Secrets live in `.dev.vars` locally and in Wrangler secrets when deployed.
- `timesifier.com` carries live email records for other services. DNS changes are limited to the Worker's custom domains and the application's one email subdomain.
- Cloudflare's APIs change quickly: check the current documentation before using one, and trust the installed versions over memory.
