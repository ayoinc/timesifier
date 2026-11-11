# Ways of working

Kanban: work is pulled one card at a time, and a card is finished when its acceptance criteria are proven.

## The board

`BOARD.md` has these columns, in the order work flows.

| Column      | Meaning                                                   | Limit        |
| ----------- | --------------------------------------------------------- | ------------ |
| Backlog     | Refined cards, in priority order                          | None         |
| Ready       | The next cards to pull; dependencies are done             | 3            |
| In progress | Being worked on                                           | 1 per worker |
| Review      | Merged or ready to merge, with a criterion still to prove | 2            |
| Done        | Merged and deployed, every criterion ticked               | None         |
| Later       | Ideas that have no acceptance criteria yet                | None         |

A worker, human or AI, has one card in progress and finishes it before pulling the next. If a card is blocked, write the blocker on the card and fix the blocker first.

A card sits in Review for one of two reasons, written on the card: a criterion can only be proven once the change is live, or a criterion waits for a decision from the owner.

## Working in parallel

Cards that do not depend on each other may be built at the same time, each by its own worker, on its own branch, in its own git worktree. One integrator owns `main`:

- before work starts, the integrator names the files each card owns and the interfaces between the cards;
- workers do not push, merge, deploy or edit `BOARD.md`; they report the evidence for each criterion;
- the integrator checks the evidence, rebases one branch at a time onto `main`, runs the checks, opens the pull request, verifies the preview, merges, and watches the deploy;
- evidence that only exists after the deploy (a production scan, a migration applied by the pipeline) is recorded on the card in the next pull request.

## Definition of Ready

A card may enter Ready when:

- every acceptance criterion states something that can be checked by a command, a test, or looking at a named page;
- the cards it depends on are Done;
- it fits in one or two working sessions. Split it if it does not.

## Acceptance criteria

Each criterion is a statement that is true or false, with no room for opinion.

- Good: "The 11th sign-in attempt in a minute from one client returns status 429."
- Too vague: "Sign-in is protected against brute force."

A criterion is ticked only with its evidence beside it: the command and its result, the test name, or the URL.

## Definition of Done

A card is Done when all of these hold:

- every acceptance criterion is ticked with evidence;
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` and `pnpm test:e2e` pass;
- the checks in `docs/security.md` that apply to the change are met;
- new behaviour has a test that would fail without the change;
- documents that the change makes wrong are corrected in the same pull request;
- the pull request is merged and the card is moved to Done with the date.

## Flow of one card

1. Move the top Ready card to In progress.
2. Create a branch named after it, for example `ts-012-timer`.
3. Build in small commits. Commit messages start with the card number: `TS-012 add running-timer constraint`.
4. Tick each criterion as its evidence exists.
5. Open a pull request that links the card. If every criterion is proven, move the card to Done in that pull request; otherwise move it to Review and say what is still to prove.
6. When the checks pass and the preview has been looked at, merge. The pipeline deploys. `main` is not protected (see TS-002), so this discipline is the only gate.

## Decisions

A choice that would be costly to reverse gets an entry in `docs/decisions.md` before the code is written: the options, the evidence and the choice. The owner settles it. Small choices are made on the card and noted in the pull request.

## Changing the plan

The board is the plan. To change scope, edit the card's criteria in a pull request of its own, before starting the work. Criteria are never loosened to make a card pass.
