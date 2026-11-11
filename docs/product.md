# Product

Timesifier is about time: a person's own, and the time of the organisation they work in. Time in seconds, minutes and hours, and in days, weeks, months and years.

A person tracks their time, sees where it went, and plans stretches of focused work. An organisation has people, teams and managers. A manager sees the time and the leave of their team. An owner or admin sees everyone's, and sets the organisation's rules about time. Everything the product does should make time easier to see and to manage.

The owner described the product this way on 2026-11-11. This document is the working scope.

Source for the earlier scope: the Timesifier PRD written in May 2025 (GitHub `ayoinc/v0-timesifier-prd`, private). Figures marked _(2025 PRD)_ have not been revalidated.

## Problem

For a person:

- Manual time tracking is tedious, so records are incomplete.
- Meetings break up deep work.
- People cannot see where their time goes.
- Switching between tasks destroys focus.

For an organisation:

- A manager cannot see their team's worked time and their leave in one place.
- The rules about time, such as the working week and how leave is earned, live in documents nobody checks against what happened.

## Who it is for

| Persona                      | Situation                                   | Wants                                                       |
| ---------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| Alex, knowledge worker       | Balances meetings, deep work and admin      | More deep-work time, fewer unproductive meetings            |
| Jordan, freelancer           | Several clients, bills by the hour          | Accurate billable time with little admin                    |
| Taylor, executive            | Calendar dominated by meetings              | A lighter meeting load and time to think                    |
| Morgan, small-business owner | Owns the organisation; does every job in it | To see where the business's time goes, and to set its rules |
| Sam, manager of a team       | Runs one practice or team inside a company  | To see the team's time and leave, and to approve time off   |

Sam was added on 2026-11-11, from the owner's description. The first target is technology professionals and freelancers _(2025 PRD)_.

## What the product does

The capabilities, in the order they would be built. "Built" means live at <https://timesifier.com>. "On the board" means a card in `BOARD.md` holds it. "Later" means no card holds it yet.

| Capability                      | What it is                                                                                                                                                 | Status                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The organisation and its people | A person signs in with a code sent by email, creates an organisation the first time, and invites people. Each person is an owner, an admin or a member.    | Built (TS-008, TS-009)                                                                 |
| Teams and managers              | A team belongs to an organisation. A person is in none, one or several. A manager is a role for one team, between admin and member.                        | On the board (TS-038)                                                                  |
| Tracking                        | Start and stop a timer against a project. Add and edit entries by hand. Projects and clients.                                                              | On the board (TS-011a, TS-012a, TS-011b, TS-012b)                                      |
| Day, week, month and year       | A person's time for a day, a week, a month and a year, with totals. Every total equals the sum of what is shown.                                           | On the board (TS-013 for the day and the week; TS-039 for the month and the year)      |
| Reports and export              | Time over a range of days by project, client or day, and the same as a CSV file.                                                                           | On the board (TS-014a, TS-014b)                                                        |
| Who sees whose time             | A person sees their own. A manager sees their team's. An owner or admin sees everyone's. Nobody changes another person's entries.                          | On the board (TS-013 and TS-014a; TS-038 for managers)                                 |
| Focus blocks                    | Planned stretches of work and breaks, in the Pomodoro manner, compared with what was tracked.                                                              | On the board (TS-017). The rhythm of work and breaks is an open question on that card. |
| Leave                           | A person asks for time off, a manager approves it, and leave is shown beside worked time.                                                                  | On the board (TS-040)                                                                  |
| The calendar                    | A person's and a team's time and leave on one calendar. Events read from an outside calendar are a separate card.                                          | On the board (TS-041; TS-016 for an outside calendar)                                  |
| Policies                        | An organisation's rules about time: the working week, how leave accrues, what needs approval. Last, because every other part gives it something to govern. | On the board (TS-042)                                                                  |

The board differs from this order in one place. The teams card waits for reports, because what a manager gains is a report of their team.

Around these, also on the board:

| Capability     | What it is                                                         | Status                                  |
| -------------- | ------------------------------------------------------------------ | --------------------------------------- |
| Trust          | Account deletion, an export of a person's data, an audit log       | On the board (TS-021a, TS-021b, TS-020) |
| AI             | A suggested project for an entry; the person accepts or rejects it | On the board (TS-015)                   |
| Weekly summary | Where the week's time went                                         | On the board (TS-018)                   |

## Release 1: the web platform

Release 1 is a web application: what a person and their organisation need to track and review time without installing anything.

Which capabilities make up release 1 is the owner's to decide, and is open. The cards written before 2026-11-11 were written as release 1. Teams and managers, the month and year views, leave, the team calendar and policies were added that day, and the owner has not yet said whether they are part of release 1 or follow it.

## After release 1

These need clients that run outside the browser or agreements with other vendors, so they follow the web platform and use its API:

- Passive tracking of applications, websites and documents (desktop app and browser extension)
- iOS and Android apps
- Two-way calendar sync and meeting scoring
- Integrations: Slack, Teams, Zoom, Asana, Jira, Trello, billing and CRM systems
- Team analytics, meeting cost and workload balancing
- Paid plans. The 2025 PRD proposed Free, Pro at $15 a month, Team at $12 per user a month, and Enterprise.

## What success looks like

Each measure is enforced by acceptance criteria on a card in `BOARD.md`. The card is named beside it.

- A new person signs in for the first time, starts a timer and sees it in the week view in under two minutes, with no instructions. TS-013: one browser test enters the address and the code, does the three set-up steps (an organisation, a project, a timer) and opens the week view inside a limit of 120 seconds. The test proves the steps are few and quick; that they need no instructions is judged by the owner when accepting each screen.
- Every total equals the sum of the entries behind it. TS-013 for the day and the week, TS-039 for the month and the year, TS-014a for reports: a property test on each.
- A person sees only the time they may see: their own, their team's if they manage it, everyone's if they are an owner or admin. Nobody changes another person's entries. TS-014a and TS-038: a test for every cell of each card's role table.
- A person in one organisation can never see another organisation's data. TS-007 for the data layer, TS-009 for the pages, and one criterion on every feature card after it.
- Every page is usable by keyboard and screen reader (WCAG 2.2 AA). A criterion on every card that builds a page, and TS-023 for the whole.
- A person can export or delete all of their data without contacting anyone. TS-021a for deletion, TS-021b for the export.
