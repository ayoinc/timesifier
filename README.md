# Timesifier

Timesifier helps individuals and teams understand and improve how they use their time: track it, plan focus around meetings, and see where it went. It runs entirely on Cloudflare at `timesifier.com`.

## Status

The scaffold is live at <https://timesifier.com> and the foundation is being built card by card. `BOARD.md` shows what is done.

## Where things are

| File                      | What it holds                                                      |
| ------------------------- | ------------------------------------------------------------------ |
| `BOARD.md`                | The Kanban board: every card with its acceptance criteria          |
| `docs/product.md`         | What Timesifier is, who it is for, what release 1 includes         |
| `docs/architecture.md`    | The Cloudflare services, environments, delivery and the domain     |
| `docs/design-system.md`   | Material 3 tokens, the design principles and the rules that follow |
| `docs/security.md`        | The security baseline and where secrets live                       |
| `docs/ways-of-working.md` | How a card moves, Definition of Ready and Done                     |
| `docs/decisions.md`       | Settled choices and their evidence                                 |
| `AGENTS.md`               | Instructions for AI coding assistants working in this repository   |

## Quick start

Needs Node 26 and pnpm 12.

```sh
pnpm install
pnpm dev          # the local address is printed; the app runs in the Workers runtime
```

Before opening a pull request:

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

`pnpm format` fixes formatting and import order. Local secrets go in `.dev.vars`; see `.dev.vars.example` and `docs/security.md`.

## Delivery

Every pull request is checked and gets a preview URL as a comment. Merging to `main` deploys to production; nothing is deployed from a laptop. The steps, the pipeline's token and the rollback command are in `docs/architecture.md`.
