# Navigation

The structure every signed-in page belongs to, adopted by the owner on 2026-11-11. It is the target: a link appears in the product only when the card that builds its page is Done, so nobody meets an empty section. Each entry names the card that builds it.

Counts are per role. Individual records, forms and tabs sit inside a section. Sign out is an action, not a page.

| Role                          | Main links | Utility items | Visible |
| ----------------------------- | ---------: | ------------: | ------: |
| Member (employee, contractor) |          4 |             4 |       8 |
| Manager                       |          6 |             4 |      10 |
| Owner or admin                |          8 |             4 |      12 |

Roles are those of `docs/security.md`, "Organisations and roles": owner, admin, member, and the manager role of TS-038.

## Main links

| #   | Link               | What it does                                                                                                                                                                                                                         | Who sees it                          | Card                                                     |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------------- |
| 1   | Dashboard          | Hours logged this week against expected hours, submission status, reminders and shortcuts. Managers also see pending approvals and missing submissions.                                                                              | Everyone                             | TS-045                                                   |
| 2   | My Timesheets      | Add and edit hours against projects and tasks, review earlier periods, submit a period, correct a returned one. The timer lives here. Views: Day, Week, Calendar. Tabs: Current period, History.                                     | Everyone                             | TS-012a, TS-012b, TS-013, TS-046                         |
| 3   | Projects           | Assigned projects and their tasks. Those allowed create projects, assign people, set hour budgets and archive. Tabs: Active, Archived. One project: Overview, Tasks, Members, Budget and rates (budget and rates for those allowed). | Everyone, with different permissions | TS-011a                                                  |
| 4   | Reports            | Time by date, project, task and person, filtered and exported. Tabs: Summary, Detailed, Submission status (managers and admins). A member sees their own, a manager their team's, an owner or admin everyone's.                      | Everyone, with different data        | TS-014a, TS-014b                                         |
| 5   | Approvals          | Approve a submitted timesheet or return it with a comment; see who has not submitted; earlier decisions. Tabs: Pending, Missing, History.                                                                                            | Managers, admins, owners             | TS-047                                                   |
| 6   | Team               | People, working hours, project assignments and submission status. Admins invite, deactivate and assign roles. Tabs: Members, Invitations, Groups.                                                                                    | Managers, admins, owners             | TS-009 (members and invitations, built), TS-038 (groups) |
| 7   | Clients            | Clients and their projects, for grouping time and reports. Tabs: Active, Archived.                                                                                                                                                   | Admins, owners, or those allowed     | TS-011b                                                  |
| 8   | Workspace settings | The organisation and its rules (below).                                                                                                                                                                                              | Admins, owners                       | TS-009 (name, built), TS-042, TS-048                     |

A workspace used only for internal work can hide Clients; that is a setting, not a second product.

## Utility items

| Item             | What it does                                                                                                        | Where        | Card                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| Notifications    | Submission reminders, approval requests, returned timesheets, approval outcomes. Each opens the record it is about. | Header       | TS-049                                                                                    |
| My account       | Name, sign-in security, time zone, notification preferences. Tabs: Profile, Security, Preferences.                  | Profile menu | Settings today (name, colour scheme, sign out); TS-012a (time zone); TS-049 (preferences) |
| Help and support | Instructions, questions, contact, report a problem.                                                                 | Profile menu | TS-050                                                                                    |
| Sign out         | Ends the session; Sign out everywhere beside it.                                                                    | Profile menu | Built (TS-008)                                                                            |

## Workspace settings

| Link                     | What it does                                                                          | Card                                 |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------ |
| General                  | Organisation name, default time zone, week start day.                                 | Name built (TS-009); the rest TS-048 |
| Working hours            | Expected hours, working days, holiday calendars.                                      | TS-042                               |
| Timesheet rules          | Submission periods, deadlines, required fields, editing restrictions, approval rules. | TS-046, TS-047                       |
| Roles and permissions    | Who may view, edit, approve and administer.                                           | TS-009 (roles), TS-038 (manager)     |
| Reminders                | Reminders to record time, submit and approve.                                         | TS-049                               |
| Integrations             | Calendars, project, accounting and payroll tools.                                     | TS-016 (calendar); the rest later    |
| Audit log                | Who changed entries, approved timesheets or changed settings, and when.               | TS-020                               |
| Subscription and billing | What a customer pays to use Timesifier.                                               | Later: there is no paid plan         |

## Later, when the scope needs them

Leave (TS-040), expenses, invoices for a customer's own clients, scheduling, a client portal. Subscription and billing is what customers pay Timesifier; invoices are what customers charge their clients.

## Where a person lands

A member lands on My Timesheets with the current week ready to fill in. A manager, admin or owner lands on Dashboard, where missing submissions and pending approvals are visible at once. Until TS-045 and TS-046 are Done, everyone lands on Today, as now.

## The navigation today

Built: Today, Reports, Projects and Settings, the last holding the organisation, members and invitations, and the person's own account. As each card above is Done, its link takes its place in this structure and this section is updated.

## Sources

The separation of sections follows Harvest's (<https://support.getharvest.com/hc/en-us/articles/44165229587469-Navigating-Harvest>); role-scoped approvals are an established pattern in Clockify. The counts and grouping are the owner's choice.
