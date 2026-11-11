# Product

Timesifier helps individuals and teams understand and improve how they use their time: track it, plan focus around meetings, and see where it went.

Source: the Timesifier PRD written in May 2025 (GitHub `ayoinc/v0-timesifier-prd`, private). This document replaces it as the working scope. Figures marked _(2025 PRD)_ have not been revalidated.

## Problem

- Manual time tracking is tedious, so records are incomplete.
- Meetings break up deep work.
- People cannot see where their time goes.
- Switching between tasks destroys focus.

## Who it is for

| Persona                      | Situation                              | Wants                                            |
| ---------------------------- | -------------------------------------- | ------------------------------------------------ |
| Alex, knowledge worker       | Balances meetings, deep work and admin | More deep-work time, fewer unproductive meetings |
| Jordan, freelancer           | Several clients, bills by the hour     | Accurate billable time with little admin         |
| Taylor, executive            | Calendar dominated by meetings         | A lighter meeting load and time to think         |
| Morgan, small-business owner | Does every job in the business         | To see which activities drive growth             |

The first target is technology professionals and freelancers _(2025 PRD)_.

## Release 1: the web platform

Release 1 is a web application. It covers what a person or a small team needs to track and review time without installing anything.

| Capability | In release 1                                                                 |
| ---------- | ---------------------------------------------------------------------------- |
| Accounts   | Sign in with a passkey or email; organisations, teams and roles              |
| Tracking   | Start and stop a timer; add and edit entries by hand; projects and clients   |
| Review     | Today and week views; reports by project, client and day; CSV export         |
| AI         | Suggested project or category for an entry; the person accepts or rejects it |
| Scheduling | Read-only calendar import; planned focus blocks compared with what happened  |
| Insight    | A weekly summary of where time went                                          |
| Trust      | Data export, account deletion, audit log                                     |

## After release 1

These need clients that run outside the browser or agreements with other vendors, so they follow the web platform and use its API:

- Passive tracking of applications, websites and documents (desktop app and browser extension)
- iOS and Android apps
- Two-way calendar sync and meeting scoring
- Integrations: Slack, Teams, Zoom, Asana, Jira, Trello, billing and CRM systems
- Team analytics, meeting cost and workload balancing
- Paid plans. The 2025 PRD proposed Free, Pro at $15 a month, Team at $12 per user a month, and Enterprise.

## What success looks like for release 1

- A new person signs up, starts a timer and sees it in the week view in under two minutes, with no instructions.
- Report totals always equal the sum of the entries behind them.
- A person in one organisation can never see another organisation's data.
- Every page is usable by keyboard and screen reader (WCAG 2.2 AA).
- The owner can export or delete all of their data without contacting anyone.

Each of these is enforced by acceptance criteria on the cards in `BOARD.md`.
