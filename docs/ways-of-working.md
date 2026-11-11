# Ways of working

Kanban: work is pulled one card at a time, and a card is finished when its acceptance criteria are proven.

## The board

`BOARD.md` has these columns, in the order work flows.

| Column | Meaning | Limit |
|---|---|---|
| Backlog | Refined cards, in priority order | None |
| Ready | The next cards to pull; dependencies are done | 3 |
| In progress | Being worked on | 1 |
| Review | Criteria met, waiting for the owner to check the evidence | 2 |
| Done | Merged and, once TS-003 exists, deployed | None |
| Later | Ideas that have no acceptance criteria yet | None |

Finish the card in progress before pulling the next. If a card is blocked, write the blocker on the card and fix the blocker first.

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
- `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` pass;
- the checks in `docs/security.md` that apply to the change are met;
- new behaviour has a test that would fail without the change;
- documents that the change makes wrong are corrected in the same pull request;
- the pull request is merged and the card is moved to Done with the date.

## Flow of one card

1. Move the top Ready card to In progress.
2. Create a branch named after it, for example `ts-012-timer`.
3. Build in small commits. Commit messages start with the card number: `TS-012 add running-timer constraint`.
4. Tick each criterion as its evidence exists.
5. Open a pull request that links the card. Move the card to Review.
6. The owner checks the evidence and merges. The card moves to Done.

## Decisions

A choice that would be costly to reverse gets an entry in `docs/decisions.md` before the code is written: the options, the evidence and the choice. The owner settles it. Small choices are made on the card and noted in the pull request.

## Changing the plan

The board is the plan. To change scope, edit the card's criteria in a pull request of its own, before starting the work. Criteria are never loosened to make a card pass.
