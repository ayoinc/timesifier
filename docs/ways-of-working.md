# Ways of working

Kanban: work is pulled one card at a time, and a card is finished when its acceptance criteria are proven.

## Roles

- **Owner.** The person whose product this is. The owner decides scope and any choice that would be costly to reverse, approves the look of a screen, and accepts the screenshots of a finished one.
- **Integrator.** The one person or session that pushes, merges, watches the deploy and edits `BOARD.md`. When a single card is in progress, its builder is the integrator.
- **Builder.** A person or an AI session building one card on its own branch. A builder has one card in progress and finishes it before pulling the next.
- **Preparer.** Whoever wrote the first plan and the first entries in `docs/decisions.md`. The word appears there in the "How" column.

The feature cards of the product, from projects (TS-011a) onwards, are built in the owner's own working sessions, one card at a time. An assistant does not build them ahead outside those sessions. It may refine a card, review one, or fix a defect the owner points at.

## The board

`BOARD.md` has these columns. The file lists them nearest to done first: In progress, Review, Ready, Backlog, then Done and Later.

| Column      | Meaning                                                    | Limit         |
| ----------- | ---------------------------------------------------------- | ------------- |
| Backlog     | Cards with criteria, in priority order                     | None          |
| Ready       | The next cards to pull, in order, refined                  | 3             |
| In progress | Being built; the card names its builder and branch         | 1 per builder |
| Review      | Merged or ready to merge, with a criterion still to prove  | 2             |
| Done        | Merged, deployed, smoke test green, every criterion ticked | None          |
| Later       | Ideas that have no acceptance criteria yet                 | None          |

A card sits in Review for one of two reasons, written on the card: a criterion can only be proven once the change is live, or a criterion waits for the owner. A card that waits only on the owner does not count against the Review limit. After seven days the integrator asks the owner again, or proposes a change to the criterion under "Changing the plan".

The integrator or the owner moves cards from Backlog to Ready. A builder who finds Ready empty asks.

If a card is blocked, the blocker is written on the card and fixed first.

## New cards

- The integrator takes the next free number. A card split in two keeps its number and gains a letter: TS-011a, TS-011b.
- A card and its criteria land on `main` in a pull request that changes only the board, before a branch is cut for the work.
- An instruction from the owner changes the plan at once. Its card is in the first pull request of that work.
- A fix for a defect needs no card. It uses a branch named `fix-…` and meets the Definition of Done.
- Anything a card leaves unfinished becomes a new card, or a row in `docs/security.md`, "Known gaps and accepted risks", and the card names it.

A card is written like this:

```markdown
### TS-0NN · What a person can do when it is done

**Depends on:** the cards that must be Done first.
**Reference for the screen:** what the owner approved (a card that adds or changes a screen).
**Owns:** the files this card may change.
**Interfaces:** what it gives other cards, and what it takes from them.
**Routes:** each address, its module, and the intents its action takes.
**Tables:** each table and column, with its type and constraint.
**Who may:** a table of actions against owner, admin and member.

- [ ] A criterion that a test, a command or a named page can decide.
```

"Routes", "Tables" and "Who may" are for cards that build a feature. A feature card also carries the criterion that every new route joins the cross-organisation 404 test of TS-009.

## Definition of Ready

A card may enter Ready when:

- every acceptance criterion states something that can be checked by a command, a test, or looking at a named page;
- every card it depends on is named on its "Depends on" line. It is pulled only when each of them is Done;
- a card that adds or changes a screen names a reference the owner has approved;
- it depends on no decision marked "Awaiting owner" in `docs/decisions.md`;
- it fits in one working session and is delivered as one pull request. Split it if it does not.

## Acceptance criteria

Each criterion is a statement that is true or false, with no room for opinion.

- Good: "The 11th sign-in attempt in a minute from one client returns status 429."
- Too vague: "Sign-in is protected against brute force."

A criterion is ticked only with its evidence beside it: the command and its result, the test name, or the URL.

## Definition of Done

Done means merged, deployed and the smoke test green, with all of these true:

- every acceptance criterion is ticked with evidence;
- the checks the pipeline runs pass: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:e2e` and `pnpm audit --audit-level=moderate`. The pipeline also scans for secrets;
- the change follows the rules in `docs/security.md`, "Rules for anyone changing the code", and the row of "Controls" for each area it touches;
- new behaviour has a test that would fail without the change;
- a change to a page has screenshots at 390px and 1280px in both colour schemes in the pull request, and the owner has accepted them. This is the usual case of a card waiting on the owner;
- documents that the change makes wrong are corrected in the same pull request;
- anything left over is a new card or a row in `docs/security.md`, "Known gaps and accepted risks", named on this card;
- the card is in Done: one line on the board with the date and the pull request, and the card itself, with its evidence, at the top of `docs/board-done.md`.

**What a preview proves.** A preview sends no email, so nobody signs in on it. Signed-in pages are verified locally on a production build and by `pnpm test:e2e`, and their screenshots come from those browser tests. The preview proves the public pages and the smoke test.

**Browser tests hold on any day and at any hour.** The pipeline runs at any hour in UTC, and typed hours never run past now (audit W08), so just after midnight today has room for none. A test that tracks time does it on a day that has passed, `pastWeekday` in `e2e/timesheet.ts`, and opens that day's week (`mondayOf`), which on a Monday is the week before. A test that must track today, such as one whose rate starts today, runs its browser where it is afternoon now (`afternoonZone`), and `workEveryDay` makes today a working day and waits for the person's zone to be the browser's. `e2e/timesheet-days.spec.ts` checks these on every day of a week. A new organisation works Monday to Friday, so at a weekend today takes no time and offers no Track time: a test that starts a timer or opens Track time on today calls `workEveryDay` first, and a Worker test that starts a timer pins the server's clock to a working day (main's runs of 14 November 2026, a Saturday).

**A shortcut key is pressed with the focus on the page.** React takes over the navigation before the page beside it, which is drawn under `<Activity>` (TS-096), and `openShell` waits for the navigation alone. A press, or a key pressed with the focus inside the page, makes React take the page over at once. A key the whole document listens for (the Timesheet's N, [ and ], the calendar's - and +), pressed with the focus still on the document, is lost until React has reached the page. A test of such a key puts the focus on the page's heading first, as `e2e/timesheet-taste.spec.ts` and `e2e/calendar.spec.ts` do.

## Flow of one card

This is the one procedure. Each step says who does it.

**The goldfish review comes before step 1.** A card that changes what a person sees, or how the system is built, has a written brief. Before building starts, the brief is read by independent reviewers who know nothing else about the project. Each reads it through one lens: is it more than was asked, can it be built without deciding any design, what breaks, can a newcomer follow it. The integrator answers their findings in the brief, and only then is the card pulled. The owner still looks at the result before the card is Done, as the Definition of Done says.

1. **Integrator:** move the top Ready card to In progress and write the builder and the branch on it. Check its "Owns" and "Interfaces" lines against the other cards in progress. If the card needs a migration, give it its number.
2. **Builder:** create a branch named after the card, for example `ts-012a-timer`, in its own git worktree.
3. **Builder:** if the card adds or changes a screen, follow `docs/design-system.md`, "From idea to shipped screen", before writing code.
4. **Builder:** build in small commits. A commit message starts with the card number: `TS-012a add running-timer index`.
5. **Builder:** run the checks in the Definition of Done. Report the evidence for each criterion: the test name, the command and its result, or the screenshots.
6. **Integrator:** check the evidence, rebase the branch onto `main` and run the checks again.
7. **Integrator:** tick the criteria on the board with their evidence. If every criterion is proven, move the card to Done in this pull request. If one can only be proven in production or waits for the owner, move it to Review and say what is left.
8. **Integrator:** open a pull request whose title starts with the card number. The pipeline checks it and posts a preview (`docs/architecture.md`, "Delivery").
9. **Integrator:** look at the preview, then merge. `main` is protected: the required checks must pass, history is linear and force pushes are refused.
10. **Integrator:** watch the deploy to the end and check production. If it is wrong, roll back first (`docs/architecture.md`, "Rollback") and fix afterwards.
11. **Integrator:** for a card in Review, record the evidence from production and move the card to Done in a follow-up pull request the same day. That pull request holds only the board edit.

Rules that hold while more than one card is in progress:

- Cards that do not depend on each other may be built at the same time, each by its own builder, on its own branch, in its own worktree.
- A builder does not push, merge, deploy or edit `BOARD.md`.
- A builder changes only the files on the card's "Owns" line. A change needed elsewhere goes through the integrator.
- All previews share one database. At most one open pull request carries a migration. The integrator assigns its number before work starts, and it merges before the next one opens.

## Decisions

A choice that would be costly to reverse gets an entry in `docs/decisions.md` before the code is written: the options, the evidence and the choice. The owner settles it. A card may not depend on a decision marked "Awaiting owner". Small choices are made on the card and noted in the pull request.

## Changing the plan

The board is the plan. To change scope, edit the card's criteria in a pull request of its own, before starting the work. Criteria are never loosened to make a card pass.
