# Navigation

The structure every signed-in page belongs to. The owner adopted it on 2026-11-11 and asked the same day for it to be checked against Harvest, the product Timesifier follows; this version is the result. It is the target: a link appears in the product only when the card that builds its page is Done, so nobody meets an empty section. Each entry names the card that builds it.

Every Harvest fact below is cited by its address; the addresses are listed under "Sources", with the tool that read each one.

## What changed after the check against Harvest

| Change                                                                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard is no longer a main link. TS-045 now builds Team's "This week" tab instead.                                  | Harvest's sidebar has no home page: Timesheet is "your home for time tracking" ([nav]). The week of the whole team is Harvest's Team overview, which shows a week at a time, each person's hours against their capacity and whether a timer is running ([team-overview]). Who has not submitted and what waits for approval are statuses of the approval page ([submission-reports]). A Dashboard would repeat all three.              |
| The links are grouped under three headings, Track, Organize and Review, in that order.                                 | Harvest's sidebar groups its tabs under headings: "Track" holds Timesheet and Expenses and "Organize" holds Team and Clients ([customize], and the sidebar in the thumbnail of the video in [nav]). Its tabs run Timesheet, Expenses, Team, Clients, Projects, Tasks, Expense Categories, Invoices, Estimates, Approvals, Reports, Integrations, Settings ([nav]). "Review" is the word Harvest's home page uses for reports ([home]). |
| My Timesheets is renamed Timesheet; its views are Day and Week. Calendar moves to Later.                               | Harvest's tab is "Timesheet", with Day, Week and Calendar views ([nav], [day], [week]). No card of release 1 builds a calendar view; TS-039 builds month and year totals.                                                                                                                                                                                                                                                              |
| The timer gets a control at the top of the navigation, on every page.                                                  | Harvest's sidebar starts with a Timer button above the first heading (thumbnail of the video in [nav]), and a running timer is shown and stopped "from their own running-timer indicator in the top-left navigation" ([day]). Open: see "Gaps the flows show".                                                                                                                                                                         |
| Reports loses its Submission status tab; Approvals shows one period at a time with Pending, Not submitted and Decided. | Harvest lists who has not submitted at Time > Unsubmitted, per week, and what waits at Time > Pending approval ([submission-reports]); its approval page filters on Status: Unsubmitted, Pending Approval, Approved, for a chosen timeframe ([approve], [flex]).                                                                                                                                                                       |
| Members and Invitations move from Settings to Team, built by TS-045.                                                   | Harvest adds and imports people "from your Team section" with "+ Invite person" ([invite], [quick]).                                                                                                                                                                                                                                                                                                                                   |
| A project's page shows only what TS-011a builds. Tasks, project members, budgets and rates move to Later.              | Harvest tracks every hour "to a task that's assigned to a project for a client" ([quick]) and assigns people to projects before they can track ([invite]). Timesifier tracks to a project with a description, and every role sees every project (TS-011a). No card of release 1 builds tasks, budgets or rates.                                                                                                                        |

What the owner set, and what this check did with it:

- **Role counts.** Each role has one main link fewer, 3, 5 and 7 instead of 4, 6 and 8, because Dashboard is gone; the reason is in the first row above. Who sees which link is otherwise as the owner set it, and the four utility items are unchanged.
- **Sign out is an action, not a page.** Harvest opens the person's profile and notification settings from their name at the top right ([members], [member-approval]); none of the sources gives signing out a page of its own, so nothing argues for changing it.
- **Clients is optional.** Harvest lets an administrator hide whole sections for everyone, "Expense tracking", "Timesheet approval", "Invoices", "Estimates", "Client dashboard" and more, and hiding one deletes no data ([modules]). Clients itself is not among them; in Harvest "all time is tracked to a task that's assigned to a project for a client" ([quick]). Timesifier's projects need no client (TS-011b), so the same kind of switch fits Clients here. TS-048 now builds it.

## Roles and counts

Counts are per role. Individual records, forms and tabs sit inside a section. The timer control is an action, not a link, and is not counted. Sign out is an action, not a page; it is one of the four utility items, as before.

| Role                          | Main links | Utility items | Visible |
| ----------------------------- | ---------: | ------------: | ------: |
| Member (employee, contractor) |          3 |             4 |       7 |
| Manager                       |          5 |             4 |       9 |
| Owner or admin                |          7 |             4 |      11 |

Roles are those of `docs/security.md`, "Organisations and roles": owner, admin, member, and the manager role of TS-038. They map onto Harvest's three classic levels ([invite], "write administrator, manager, or member"): Harvest's Administrator is our owner or admin, its Manager our manager, its Member our member. Harvest now also offers six built-in roles and custom roles ([permissions]); see "Deliberately not copied".

## The navigation, top to bottom

**Timer control** (everyone): at the top of the navigation, above Track. With nothing running it reads "Start timer" and opens the Day view with the timer form. With an entry running it shows the project, the time elapsed and a Stop button, on every page. Card: TS-012a builds the timer on the Day view; the control in the navigation is open (see "Gaps the flows show").

| #   | Heading  | Link               | What it does                                                                                                                                                                                                                                      | Who sees it                            | Card                                                    |
| --- | -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| 1   | Track    | Timesheet          | The person's own time. Day view: the timer and the day's entries. Week view: seven days, a total per day and per project, and "Submit week" at its foot. Previous and Next move by a day or a week. History lists past periods with their status. | Everyone                               | TS-012a, TS-013, TS-012b, TS-046                        |
| 2   | Organize | Projects           | The organisation's projects. Tabs: Active, Archived. Create, rename, archive, restore.                                                                                                                                                            | Everyone (every role manages projects) | TS-011a                                                 |
| 3   | Organize | Clients            | Clients and their projects, for grouping time and reports. Tabs: Active, Archived. Hidden for everyone when the workspace turns Clients off.                                                                                                      | Admins, owners, or those allowed       | TS-011b; the switch TS-048                              |
| 4   | Organize | Team               | Tabs: This week (each person's hours, a running timer, the period's submission status; arrows to earlier weeks), Members, Invitations, Teams. Opening a person shows their week, read-only.                                                       | Managers (their teams), admins, owners | TS-045; TS-009 (members and invitations, built); TS-038 |
| 5   | Review   | Approvals          | One period at a time, with Previous and Next. Tabs: Pending, Not submitted, Decided. Approve one or all pending, return with a comment, remind those who have not submitted. The link shows the number pending.                                   | Managers (their teams), admins, owners | TS-047; reminders TS-049                                |
| 6   | Review   | Reports            | Time over a chosen range, grouped by project, client or day, filtered by person, and exported as CSV. A member sees their own, a manager their teams', an owner or admin everyone's.                                                              | Everyone, with different data          | TS-014a, TS-014b; managers TS-038                       |
| 7   | (none)   | Workspace settings | The organisation and its rules (below).                                                                                                                                                                                                           | Admins, owners                         | TS-009 (name, built), TS-042, TS-048                    |

A heading shows only when the person sees at least one link under it, so a member sees Track, Organize and Review with one link each. Workspace settings sits below the groups, as Harvest's Settings sits below Integrations ([nav]).

## Utility items

| Item             | What it does                                                                                                     | Where        | Card                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| Notifications    | Submission reminders, approval requests, returned periods, approval outcomes. Each opens the record it is about. | Header       | TS-049                                                                                    |
| My account       | Name, sign-in security, time zone, notification preferences. Tabs: Profile, Security, Preferences.               | Profile menu | Settings today (name, colour scheme, sign out); TS-012a (time zone); TS-049 (preferences) |
| Help and support | Instructions, questions, contact, report a problem.                                                              | Profile menu | TS-050                                                                                    |
| Sign out         | Ends the session; Sign out everywhere beside it.                                                                 | Profile menu | Built (TS-008)                                                                            |

Harvest keeps the same split: the person's profile and notification settings open from their name ([members], [member-approval]), and account-wide Settings is a place managers can never open ([manager-never]).

## Workspace settings

| Link                     | What it does                                                                          | Card                                 |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------ |
| General                  | Organisation name, default time zone, week start day, and whether Clients is shown.   | Name built (TS-009); the rest TS-048 |
| Working hours            | Expected hours, working days, holiday calendars.                                      | TS-042                               |
| Timesheet rules          | Submission periods, deadlines, required fields, editing restrictions, approval rules. | TS-046, TS-047                       |
| Roles and permissions    | Who may view, edit, approve and administer.                                           | TS-009 (roles), TS-038 (manager)     |
| Reminders                | Reminders to record time, submit and approve.                                         | TS-049                               |
| Integrations             | Calendars, project, accounting and payroll tools.                                     | TS-016 (calendar); the rest later    |
| Audit log                | Who changed entries, approved periods or changed settings, and when.                  | TS-020                               |
| Subscription and billing | What a customer pays to use Timesifier.                                               | Later: there is no paid plan         |

Harvest keeps its week start, timesheet deadline, reminders and approval rules together under Settings > Preferences ([timesheet-settings], [reminders], [approve]); Timesifier splits them by card, and the pages may merge when they are built.

## Where a person lands

Everyone lands on Timesheet, on the Day view of today, with the timer ready. That is where Harvest sends a new account first ("Head to Time > Timesheet", [quick]) and what it calls "your home for time tracking" ([nav]). Managers and admins track time too; what waits for them shows as the number on Approvals and in Notifications. Today, the Today destination of TS-012a is that page; TS-046 renames it Timesheet.

## Flows

Each flow is first Harvest's, step by step with its source, then Timesifier's through the structure above, with the card that builds each step. "Built" means it is in production now.

### 1. First sign-in and setup

Harvest:

1. A new account starts from a form asking first name, last name, company name, work email and password, for a free trial with no credit card ([signup]); the home page says the trial lasts 30 days ([home]).
2. Sign-in is at id.getharvest.com with email and password, Google, or SAML; a person in several accounts picks one after signing in ([signin]).
3. The quick start guide runs: start tracking time in Time > Timesheet, invite a teammate from Team, create a project in Projects, add tasks in Manage > Tasks, and set account preferences such as timer mode and time display in Settings > Preferences ([quick]).
4. An invited person accepts an emailed invitation, then signs in at id.getharvest.com ([members]).

Timesifier:

| Step                                                                                              | Where                               | Card           |
| ------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------- |
| Enter an email on the one sign-in page, enter the code sent to it                                 | `/sign-in`                          | Built (TS-036) |
| A new person names an organisation; a person in several picks one                                 | `/app/new`, `/app`                  | Built (TS-009) |
| Create the first project from Projects' empty state                                               | Organize > Projects                 | TS-011a        |
| Start the timer; the whole flow under two minutes                                                 | Track > Timesheet, Day view         | TS-012a        |
| Set the time zone                                                                                 | My account > Preferences            | TS-012a        |
| An owner or admin sets the default time zone and week start                                       | Workspace settings > General        | TS-048         |
| An invited person opens the emailed link, signs in with the code, accepts, and lands on Timesheet | `/invitations/<id>`, then Timesheet | Built (TS-009) |

Not copied: a password, a trial, and the request for a company name before the first sign-in. Timesifier asks for an email first and the organisation's name after, so one page serves new and returning people (TS-036).

### 2. Tracking time: timer and manual, day and week

Harvest:

1. Timer: Time > Timesheet, "+ Track time", choose project and task, add notes, "Start timer" ([day]). A running timer can be stopped from the indicator in the navigation ([day]).
2. After the fact, day: the same form, but enter a duration (or start and end) and "Save entry" ([day]).
3. After the fact, week: switch to Week, "+ Add row" for a project and task, type hours in each day; rows can be copied from the last timesheet ([week]). The Week view takes durations only, has no notes and no timer ([week]).
4. Past or future days are reached with arrows or a calendar, unless the day is locked ([day], [week]).

Timesifier:

| Step                                                          | Where                                      | Card            |
| ------------------------------------------------------------- | ------------------------------------------ | --------------- |
| Start the timer with a project and a description; stop it     | Track > Timesheet, Day view                | TS-012a         |
| Start or stop from any page                                   | Timer control at the top of the navigation | Open (see gaps) |
| See the day's entries and total; move by day                  | Day view                                   | TS-013          |
| See the week: totals per day and per project; move by week    | Week view                                  | TS-013          |
| Add, edit or delete an entry by hand, from the keyboard alone | Day view                                   | TS-012b         |
| Enter a week's hours in a grid of projects by days            | Week view                                  | Open (see gaps) |
| A day in an approved period cannot be changed                 | Day and Week views                         | TS-046          |

### 3. Submitting a week for approval

Harvest:

1. On Time > Timesheet press "Submit week for approval" at the lower right and confirm "Yes, submit timesheet" ([approve], [member-approval]).
2. A custom range can be submitted from the arrow beside that button ([approve]).
3. A submitted timesheet can still be edited until it is approved; approving locks the whole week ([approve], [member-approval]).
4. To change an approved week the person asks an administrator, who can withdraw approval ([member-approval]).
5. Administrators can set weekly reminders before and after a deadline, and people can set daily reminders for themselves ([reminders]).

Timesifier:

| Step                                                                 | Where                                   | Card           |
| -------------------------------------------------------------------- | --------------------------------------- | -------------- |
| Press "Submit week" at the foot of the Week view and confirm         | Track > Timesheet, Week view            | TS-046         |
| The week header shows Not submitted, Submitted, Approved or Returned | Week view; History                      | TS-046         |
| Withdraw a submission that is not yet decided, and edit again        | Week view                               | TS-046         |
| A returned period shows the reason; correct it and submit again      | Week view, opened from the notification | TS-046, TS-049 |
| Reminders before and after the deadline                              | Notifications and email                 | TS-049         |

Different from Harvest on purpose: a submitted period is locked until it is decided, and the person withdraws it to edit. Harvest lets entries change under an approver's eyes ([approve]); Timesifier approves exactly what was submitted, and the withdrawal leaves a record (TS-020).

### 4. Approving or returning

Harvest:

1. The approver opens Approvals (Time > Approval in the older navigation), with Status: Pending approval ([nav], [flex]).
2. Filters by client, project, role or teammate, and groups by person, project or client ([approve], [flex]).
3. "Approve" on one row, or approve everything visible at once ([approve], [flex]).
4. Harvest cannot reject: the approver emails the person to edit and resubmit, or edits their time ([approve]).
5. For Status: Unsubmitted the approver can "Send reminder" or "Force submit" ([flex]).
6. Administrators approve everyone; managers approve their assigned people and the projects they manage ([approve], [faq]); a project manager cannot approve their own time by default ([flex]). Only administrators withdraw approval ([approve], [manager-never]).
7. Approvers can opt in to an email when a timesheet is submitted ([faq]).

Timesifier:

| Step                                                                          | Where                             | Card           |
| ----------------------------------------------------------------------------- | --------------------------------- | -------------- |
| A notification says a period was submitted; the number on Approvals goes up   | Notifications; Review > Approvals | TS-049, TS-047 |
| Open Approvals, Pending, for one period; choose a person to see their entries | Review > Approvals                | TS-047         |
| Approve one, or approve all pending on the page                               | Approvals, Pending                | TS-047         |
| Return with a comment of at most 500 characters                               | Approvals, Pending                | TS-047         |
| See who has not submitted a closed period, and send them a reminder           | Approvals, Not submitted          | TS-047, TS-049 |
| A manager's own period goes to an admin or owner                              | Approvals                         | TS-047         |
| An owner or admin reopens an approved period with a reason                    | Approvals, Decided                | TS-047         |
| Every decision is recorded with who and when                                  | Workspace settings > Audit log    | TS-047, TS-020 |

Different from Harvest on purpose: Return with a comment instead of an email outside the product, so the reason travels with the period and is recorded.

### 5. Running a report and exporting it

Harvest:

1. Reports > Time shows hours and billable information by client, project, task and teammate ([reports]).
2. Reports > New report > Detailed time lists each entry, filtered by timeframe, clients, projects, tasks and team ([reports]).
3. Export to CSV or Excel, and the detailed report to PDF ([reports]).
4. Administrators see everything; managers their projects and assigned people; members only their own time ([reports]).
5. Reports can be saved, shared and placed on dashboards ([reports], [dashboards]).

Timesifier:

| Step                                                                  | Where            | Card            |
| --------------------------------------------------------------------- | ---------------- | --------------- |
| Open Reports, choose a range of days, group by project, client or day | Review > Reports | TS-014a         |
| Narrow to one person (owners, admins; managers for their teams)       | Reports          | TS-014a, TS-038 |
| Export the entries as CSV                                             | Reports, Export  | TS-014b         |

### 6. Inviting a person

Harvest:

1. Team, "+ Invite person"; enter name and email, then roles, capacity and rates ([invite]).
2. "Invite and continue" sends the email; then choose the permission level, assign projects, and for a manager assign the people they approve ([invite], [assign]).
3. An administrator can resend an expired or lost invitation ([invite]).
4. Only administrators invite in the classic levels: "Managers can never … invite people" ([manager-never]).

Timesifier:

| Step                                                                                           | Where                              | Card                                                |
| ---------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------- |
| An owner or admin opens Team, Invitations, enters an email and a role (admin or member), sends | Organize > Team, Invitations       | Built at Settings (TS-009); moves to Team in TS-045 |
| The invited person opens the link within 7 days, signs in with the code, and accepts           | `/invitations/<id>`                | Built (TS-009)                                      |
| An owner or admin puts the person in a team with a manager                                     | Team, Teams                        | TS-038                                              |
| An owner or admin sets the person's working hours                                              | Workspace settings > Working hours | TS-042                                              |

No project assignment step: every role sees every project (TS-011a). No resend: an invitation is cancelled and sent again (`docs/security.md`, "Invitations").

## Gaps the flows show

On the cards this check may change (TS-045 to TS-050), the gaps are closed in `BOARD.md`:

- TS-045 had no source for expected hours: they come from TS-042, now a dependency of its expected-hours column.
- TS-046 now has the Submit week button, withdrawal of an undecided submission, and the rename of Today to Timesheet.
- TS-047 now has approve all, a manager not deciding their own period, reopening an approved period by an owner or admin, and one period at a time.
- TS-048 now has the switch that hides Clients.
- TS-049 now has the reminder sent from Approvals, Not submitted.
- TS-050 now answers each flow on this page.

Open for the owner, on cards this check did not change:

- **The timer control in the navigation.** Harvest shows it on every page ([day]). It would be a criterion of TS-012a, which is in Ready; the card is unchanged.
- **Entering a week's hours in a grid.** Harvest's Week view is built for it ([week]). TS-013's Week view only reads, and TS-012b adds entries one at a time. It would be a criterion of TS-012b.
- **Whether approval can be turned off.** Harvest makes timesheet approval a section an administrator switches off ([modules], [approve]), and its pricing page lists timesheet approvals among the Enterprise plan's features ([pricing]). A one-person workspace has nobody to approve; the default is on until the owner says otherwise.

## Later, when the scope needs them

Not in release 1, though Harvest has them:

- **Invoices, estimates and payments** ([nav], [inv]). Subscription and billing is what customers pay Timesifier; invoices are what customers charge their clients.
- **Expenses and expense categories** ([nav]).
- **Time off** (TS-040 builds Leave).
- **Tasks within projects, project members, budgets, billable and cost rates** ([quick], [invite]).
- **A calendar view of the day** ([nav]); month and year totals are TS-039.
- **Scheduling** (Harvest Forecast, [home]), and a client portal (Harvest's client dashboard, [modules]).
- **Custom dashboards and saved reports** ([dashboards], [reports]).
- **Rearranging the sidebar** ([customize]).

## Deliberately not copied

- **A dashboard as the home page.** Covered in the first table.
- **Six built-in roles and custom roles** ([permissions]). Timesifier keeps owner, admin, member and manager; finer permissions wait for a customer who needs them.
- **Project assignment before tracking** ([invite]). The owner decided every role sees and manages every project (TS-011a).
- **Editing after submission, and no rejection** ([approve]). See flows 3 and 4.
- **Force submit on someone's behalf** ([flex]). A period is submitted by the person whose time it is.
- **Manager self-approval as a setting** ([flex]). A manager's own period always goes to an admin or owner.
- **A password and a trial at sign-up** ([signup]). One page and a code (TS-036).

## The navigation today

Built: Today, Reports, Projects and Settings, the last holding the organisation, members and invitations, and the person's own account. As each card above is Done, its link takes its place in this structure and this section is updated.

## Sources

Read on 2026-11-11. "rea" is `capture_browser_scenario` of the rea MCP server, run in Chrome with no account; it captured each page's accessibility tree and a screenshot, saved as `cmux-assets/browser/timesifier/harvest-*.png` in the session directory. The help centre sits behind a bot check that a headless browser does not pass, so its articles were opened by rea in a visible browser, and their text read through the help centre's public JSON for the same articles, also loaded by rea.

| Label                | Address                                                                                                                            | Read by                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [home]               | <https://www.getharvest.com/>                                                                                                      | rea, with the Features and Solutions menus opened                                            |
| [features]           | <https://www.getharvest.com/features>                                                                                              | rea                                                                                          |
| [tt]                 | <https://www.getharvest.com/features/time-tracking-software>                                                                       | rea                                                                                          |
| [rep]                | <https://www.getharvest.com/features/reports-and-analysis>                                                                         | rea                                                                                          |
| [inv]                | <https://www.getharvest.com/features/invoicing-and-payments>                                                                       | rea                                                                                          |
| [integrations]       | <https://www.getharvest.com/integrations>                                                                                          | rea                                                                                          |
| [pricing]            | <https://www.getharvest.com/pricing>                                                                                               | rea                                                                                          |
| [signup]             | <https://www.getharvest.com/signup>                                                                                                | rea (read only, nothing submitted)                                                           |
| [nav]                | <https://support.getharvest.com/hc/en-us/articles/44165229587469-Navigating-Harvest>                                               | rea; the video's thumbnail <https://img.youtube.com/vi/TIkbG34Wj9o/maxresdefault.jpg> by rea |
| [customize]          | <https://support.getharvest.com/hc/en-us/articles/49108454339981-Customize-your-navigation>                                        | rea, and its image                                                                           |
| [quick]              | <https://support.getharvest.com/hc/en-us/articles/4411239395341-Quick-start-guide>                                                 | rea                                                                                          |
| [members]            | <https://support.getharvest.com/hc/en-us/articles/360048181572-Members-Getting-started>                                            | rea                                                                                          |
| [signin]             | <https://support.getharvest.com/hc/en-us/articles/360048180632-Signing-in-and-switching-accounts>                                  | rea                                                                                          |
| [day]                | <https://support.getharvest.com/hc/en-us/articles/360048181892-Tracking-time-Day-view>                                             | rea                                                                                          |
| [week]               | <https://support.getharvest.com/hc/en-us/articles/360048687531-Track-and-edit-time-in-the-Week-view>                               | rea                                                                                          |
| [timesheet-settings] | <https://support.getharvest.com/hc/en-us/articles/4405577837709-Members-Timesheet-settings>                                        | rea                                                                                          |
| [approve]            | <https://support.getharvest.com/hc/en-us/articles/360048181832-Submitting-and-approving-timesheets>                                | rea                                                                                          |
| [flex]               | <https://support.getharvest.com/hc/en-us/articles/39974542812429-Flexible-timesheet-approval>                                      | rea                                                                                          |
| [member-approval]    | <https://support.getharvest.com/hc/en-us/articles/360048687011-Members-Timesheet-approval>                                         | rea                                                                                          |
| [faq]                | <https://support.getharvest.com/hc/en-us/articles/360048181912-Timesheet-approval-FAQ>                                             | rea                                                                                          |
| [submission-reports] | <https://support.getharvest.com/hc/en-us/articles/27570699929229-Timesheet-submission-reports>                                     | rea                                                                                          |
| [reminders]          | <https://support.getharvest.com/hc/en-us/articles/360058596112-Timesheet-reminders>                                                | rea                                                                                          |
| [permissions]        | <https://support.getharvest.com/hc/en-us/articles/44171549176077-Permissions>                                                      | rea                                                                                          |
| [manager-never]      | <https://support.getharvest.com/hc/en-us/articles/30704133376269-What-can-people-with-Manager-permissions-never-access-in-Harvest> | rea                                                                                          |
| [assign]             | <https://support.getharvest.com/hc/en-us/articles/4422314817677-Making-people-assignments-for-Managers>                            | rea                                                                                          |
| [invite]             | <https://support.getharvest.com/hc/en-us/articles/360048181732-How-to-add-and-import-people>                                       | rea                                                                                          |
| [team-overview]      | <https://support.getharvest.com/hc/en-us/articles/360048687431-Team-overview>                                                      | rea                                                                                          |
| [reports]            | <https://support.getharvest.com/hc/en-us/articles/360054457791-What-reports-and-exports-are-available-in-Harvest>                  | rea                                                                                          |
| [dashboards]         | <https://support.getharvest.com/hc/en-us/articles/49057982486669-Dashboards>                                                       | rea                                                                                          |
| [modules]            | <https://support.getharvest.com/hc/en-us/articles/360048685091-Enabling-and-disabling-sections-of-Harvest>                         | rea                                                                                          |

Not established: Harvest's public pages and help centre do not say which page each role lands on after signing in, and the images available show the sidebar only as far as Organize > Clients, so the headings below it are not known. The public site has no separate feature pages for approvals, team or expenses; those were read in the help centre and in the sections of [features].

[home]: https://www.getharvest.com/
[features]: https://www.getharvest.com/features
[tt]: https://www.getharvest.com/features/time-tracking-software
[rep]: https://www.getharvest.com/features/reports-and-analysis
[inv]: https://www.getharvest.com/features/invoicing-and-payments
[integrations]: https://www.getharvest.com/integrations
[pricing]: https://www.getharvest.com/pricing
[signup]: https://www.getharvest.com/signup
[nav]: https://support.getharvest.com/hc/en-us/articles/44165229587469-Navigating-Harvest
[customize]: https://support.getharvest.com/hc/en-us/articles/49108454339981-Customize-your-navigation
[quick]: https://support.getharvest.com/hc/en-us/articles/4411239395341-Quick-start-guide
[members]: https://support.getharvest.com/hc/en-us/articles/360048181572-Members-Getting-started
[signin]: https://support.getharvest.com/hc/en-us/articles/360048180632-Signing-in-and-switching-accounts
[day]: https://support.getharvest.com/hc/en-us/articles/360048181892-Tracking-time-Day-view
[week]: https://support.getharvest.com/hc/en-us/articles/360048687531-Track-and-edit-time-in-the-Week-view
[timesheet-settings]: https://support.getharvest.com/hc/en-us/articles/4405577837709-Members-Timesheet-settings
[approve]: https://support.getharvest.com/hc/en-us/articles/360048181832-Submitting-and-approving-timesheets
[flex]: https://support.getharvest.com/hc/en-us/articles/39974542812429-Flexible-timesheet-approval
[member-approval]: https://support.getharvest.com/hc/en-us/articles/360048687011-Members-Timesheet-approval
[faq]: https://support.getharvest.com/hc/en-us/articles/360048181912-Timesheet-approval-FAQ
[submission-reports]: https://support.getharvest.com/hc/en-us/articles/27570699929229-Timesheet-submission-reports
[reminders]: https://support.getharvest.com/hc/en-us/articles/360058596112-Timesheet-reminders
[permissions]: https://support.getharvest.com/hc/en-us/articles/44171549176077-Permissions
[manager-never]: https://support.getharvest.com/hc/en-us/articles/30704133376269-What-can-people-with-Manager-permissions-never-access-in-Harvest
[assign]: https://support.getharvest.com/hc/en-us/articles/4422314817677-Making-people-assignments-for-Managers
[invite]: https://support.getharvest.com/hc/en-us/articles/360048181732-How-to-add-and-import-people
[team-overview]: https://support.getharvest.com/hc/en-us/articles/360048687431-Team-overview
[reports]: https://support.getharvest.com/hc/en-us/articles/360054457791-What-reports-and-exports-are-available-in-Harvest
[dashboards]: https://support.getharvest.com/hc/en-us/articles/49057982486669-Dashboards
[modules]: https://support.getharvest.com/hc/en-us/articles/360048685091-Enabling-and-disabling-sections-of-Harvest
