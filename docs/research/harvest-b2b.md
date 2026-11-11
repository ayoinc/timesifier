# Harvest's business features, and the cards that would bring them to Timesifier

Written 2026-11-11 for the owner's three asks: leave in the platform with a live "on leave" status, the business-to-business features Harvest has and Timesifier lacks, and a build order. This is research only. Nothing in `timesifier/platform` was changed. The cards below are proposals: they get IDs **B1 to B22** here and should be renumbered from TS-060 when they go on `BOARD.md`. Five existing cards are amended rather than duplicated: TS-040, TS-041, TS-042, TS-049 and TS-014b, with TS-020 extended by B17. Each one still needs its routes, tables, role table and goldfish review when it reaches Ready, as `BOARD.md` says for TS-040 to TS-042.

## How this was observed

- **The owner's signed-in Harvest** (30-day trial, Owner role): I used rea `capture_browser_scenario` over CDP in a fresh headless Chrome carrying the cmux session (`/tmp/rea-fresh.sh`). Steps were limited to `goto`, plus `click` on tabs and on "New invoice" and "Track expenses". No save, create, invite, send or activate button was pressed. The accessibility tree of each page is saved in `timesifier/research/harvest-app/b2b/<step>.txt`. The first line of each file names the rea step and the address. Some captures have their middle cut by the gateway (`[…NB elided…]`) where Harvest's long currency or time-zone lists made the tree too large: `preferences-edit.txt`, `project-edit.txt`, `invoices-appearance.txt`. The parts used here are outside the cut.
- **Help centre**: Harvest's public Zendesk JSON. The address in the brief (`/api/v2/help_center/en-us/articles/search.json`) returns 404. What works is `/api/v2/help_center/articles/search.json?locale=en-us&query=…` and `/api/v2/help_center/en-us/articles.json`. All 449 English articles, plus the Time Off article that search returns, are saved as text in `timesifier/research/harvest-help/articles.jsonl`. Each article is cited below by its URL.
- **Side effect to report.** On the first visit to `/invoices`, Harvest created a sample draft invoice by itself ("Invoice 1", "Demo Invoice", £100.00, Example Client) and redirected to its edit page (`invoice-edit-demo.txt`; `invoice-view.txt` shows "Created: 4 minutes ago"). No button was pressed. It is Harvest's onboarding sample, like "Example Client" and "Example Project". The owner can delete it in Harvest if it is unwanted.
- **Not reachable**: the expense form. After "Track expenses" the captured tree did not show it, so the form is described from the help article. `/tasks/new` is a 404; tasks are created from a dialog on `/tasks` (`research/harvest-app/tasks.txt`, from the earlier session). Time off is behind the activation wizard (`pto.txt`), so all of it comes from the help centre.

## Timesifier today (baseline)

Taken from `migrations/0000`–`0006`. The tables are `organisations` (time zone, week start, clients switch), `users`, `memberships` (role owner/admin/manager/member), `invitations`, `teams` and `team_members` (`is_manager`), `clients` (name only), `projects` (name, client, archived), `time_entries` (project, description, start, end) and `periods` with `period_events` (submitted, withdrawn, approved, returned, reopened). It does not have tasks, billable flags, rates, budgets, capacity, leave, expenses, invoices, estimates, a contractor flag, an audit log, saved reports, import, a lock date, or reminders. `docs/navigation.md` "Later" names most of these. "Deliberately not copied" names custom roles and project assignment before tracking, and the cards below respect those choices or say plainly where they would reopen one.

---

## 1. Time off (leave)

**Source.** Help: [Time Off][to]. Harvest app: `pto.txt` (`/pto` redirects to `/pto/activation`, the wizard "Overview, Holiday calendars, Assign people, Vacation policy" with "Clear balances", "One team calendar" and "Simple requests"); `team-assignments.txt` ("Team capacity 35.00 Base 35.00 / Time off -0.00"); `notification-settings.txt` (three time-off notifications); `people-new.txt` ("Employment start date … can be used in time off accrual"); `settings-bulk.txt` ("working hours (Time off accounts)"); `settings-modules.txt` (Time off is a module).

**How it works in Harvest**

1. Setup (administrator, first visit). (a) Pick holiday calendars by country; Harvest creates an editable calendar per country. (b) Assign each person to a calendar; the administrator must include themselves. (c) Create the first type, "Vacation", with its balance type, accrual, allowance, carryover and approval. Non-admins see "Contact an admin" instead.
2. **Time-off types** (Time off › Configure). Each type has a colour and an icon, and is one of three balance types: _Available upfront_, _Accrued_ (monthly, every 2 weeks, twice a month, or per hour worked) or _Unlimited_. Each type also has:
   - a default allowance in days a year;
   - _deferred accrual_, where days earned this year become usable next year, as the law requires in Belgium, France and Sweden;
   - a maximum carryover in days or hours; a negative balance always carries over;
   - _increases with service_, steps of "after N years, X days a year" counted from the employment start date;
   - whether a request needs approval;
   - whether members can see and request the type.
     Types can be deactivated and restored.
3. **Leave year**: calendar year, each person's hire anniversary, or a custom start date. Changing it recalculates every year, with no proration.
4. **Request** (My time off): pick a type, then full days or a partial day, then the dates. Harvest previews the effect on the balance, takes an optional note, then submits. Non-working days and holidays are skipped automatically. If the request overlaps an existing one, the person keeps both or replaces the old one. The page shows each type's allowance, used, pending and remaining.
5. **Approve** (Time off › Approvals): approve, request changes, or reject, with the before and after balance shown. Conflicts are flagged when teammates who share projects are away on the same day. Approvers are administrators, plus anyone given "Approve time off for people they manage" or "… across the account". Viewing has its own pair of permissions.
6. **Cancel**: a person cancels a pending request, or an approved one that has not fully passed. Once it has passed, only an administrator can cancel it, after a warning that balances, timesheets and reports will be recalculated. Leave inside a locked period cannot be cancelled.
7. **Where it shows**:
   - approved leave appears on the timesheet as informational entries that add nothing to tracked hours, and the person can still track work that day;
   - Team › Assignments takes time off away from capacity ("Base 35.00 / Time off −x");
   - the Team calendar shows approved and pending leave, filtered by department, role, project, client or person, and its _Manage allowance_ tab holds per-person overrides;
   - Reports › Time off shows allowance, used, booked, pending and remaining per person and type, and exports to CSV or Excel;
   - each person can sync approved leave one way to Google or Outlook as out-of-office events, from today onwards;
   - leave can be imported from CSV, and imported leave counts as approved.
8. **Notifications**: a request for my review, my request reviewed, a request cancelled. Each is in-app and/or email (`notification-settings.txt`).

**B2B value.** One place for "who is off and when": the balances that payroll and HR need, approval with an audit trail, and capacity and utilisation that are not distorted by holidays. That makes it a selling point for teams of 5 to 200 that otherwise run a separate leave tool such as BrightHR, Timetastic or Charlie.

**What Timesifier lacks.** Everything. TS-040, TS-041 and TS-042 exist, but their open questions are not answered. Harvest's answers make good defaults:

- **Kinds of leave**: types defined by the organisation. Seed them with Annual leave, Sick, Study and Unpaid, as the owner listed.
- **Unit**: days, with half days. Partial hours can come later.
- **Approval**: set per type, so Sick needs none and Annual needs it.
- **Accrual**: up front or monthly.
- **Who decides when nobody manages the person**: owner or admin.

**Proposed cards** (amend TS-040 and TS-042, add B2 and B3)

**TS-040 · Leave**, amended. Depends on TS-038 and B1.

- [ ] An owner or admin creates, renames, deactivates and restores leave types for the organisation. A new organisation starts with Annual leave, Sick leave, Study leave and Unpaid leave. A manager or member cannot change types (a test for every cell of the role table).
- [ ] A person asks for leave of one type from a first day to a last day, as whole days, or as a single half day (morning or afternoon), in their time zone. A last day before the first is refused (test).
- [ ] The request counts only the person's working days (B1) and skips the organisation's holidays. A request from Friday to Monday over a normal weekend counts 2 days (test).
- [ ] A request that overlaps the person's existing pending or approved leave is refused, with the overlapping request named (test).
- [ ] A request for a type that needs approval waits until a manager of a team the person is in, an owner or an admin approves it, returns it with a reason, or refuses it. A type that needs none is approved when made (tests per role cell).
- [ ] A decided request cannot be decided again. A person cancels their own pending request, or an approved one whose first day is still in the future. Only an owner or admin cancels leave that has started. Each step is written to the request's history with who did it (test).
- [ ] Approved leave shows on the person's Day and Week views as a non-editable row of its type and hours. No total of worked time includes it (test).
- [ ] A request of one organisation is never shown or decided in another (test).

**TS-042 · Policies**, amended. Depends on TS-040 and B1. Its first criterion, the working week, moves to B1.

- [ ] Each leave type has a balance kind: _up front_ (the whole year's allowance on the first day of the leave year), _monthly accrual_ (1/12 on the first of each month) or _unlimited_ (no balance). It also has an allowance in days and a maximum carry-over. The organisation sets one leave-year start date (test).
- [ ] An owner or admin gives one person a different allowance for a type. Removing the override puts the person back on the default (test).
- [ ] For random policies and requests, a person's balance for a type on any day equals what has been granted or accrued by that day, plus carry-over (capped), less approved leave taken or booked (property test).
- [ ] A request that would take a balance below zero is refused unless the type allows a negative balance (test).
- [ ] An owner or admin keeps a list of holidays, each with a date and a name, and says which people it applies to. A holiday never counts against a balance (test).
- [ ] A change to a policy applies from the day it is made. No decided request changes (test).
- [ ] A person sees, for each type, allowance, taken, booked (approved, in the future), pending and remaining, on My leave (test).

**B2 · Who is off now.** Depends on TS-040, TS-045. This is the owner's "live not working / on leave" status.

- [ ] On Team, each person whose approved leave covers today in their own time zone shows "On leave" with the type and the day they are back. A person who is not working today (a non-working day under B1, or a holiday) shows "Not working". Anyone else shows nothing, or their running timer as now (test with a person in another time zone across midnight).
- [ ] The same status shows beside the person's name wherever a manager reads it: Team, Approvals, and the person's week (test).
- [ ] A member sees the status only for people the leave visibility rule lets them see (role table; the open question on TS-041). Nobody sees the leave type of a person outside that rule (test).
- [ ] The status is computed when the page is read, not stored. Cancelling leave clears it on the next read (test).

**TS-041 · The team calendar**, amended. Depends on TS-040, TS-013.

- [ ] Pending leave is shown, marked as pending, beside approved leave (test).
- [ ] Filters by team and by person. The address carries the month (test).
- [ ] When two people in the same team are both on leave on a day, an approver sees that day flagged while deciding a request that covers it (test).

**B3 · Leave in reports and capacity.** Depends on TS-042, B1, TS-014a.

- [ ] Reports has a Leave view: allowance, taken, booked, pending and remaining per person and type for the leave year, with a CSV export of one row per person per type (test that the CSV totals equal the screen).
- [ ] A person's expected hours for a week are their capacity (B1) less approved leave and holidays in that week. Team's week (TS-045) shows "Expected", "Leave" and "Logged" (test with a 3-day leave in a 5-day week giving 2/5 of capacity).
- [ ] A subscribable calendar feed (ICS) per person, and one per team for its managers, lists approved leave only. A secret URL can be revoked, and revoking it makes the old URL return 404 (test). Outlook and Google read ICS, so no OAuth integration is needed for the first version.

---

## 2. Capacity and utilisation

**Source.** Help: [Setting and editing capacity][cap], [Utilization rate][util], [Can I stop my team tracking more than capacity][capstop]. Harvest app: `settings-preferences.txt` ("Default capacity 35 hours per week"), `people-new.txt` ("Capacity … hours per week"), `team-assignments.txt` (columns Hours, Utilization, Available capacity, Billable hours; "Team capacity 35.00 Base 35.00 / Time off -0.00"; 20/40/60/80% bands).

**How it works**

1. An admin sets a default capacity in Settings › Preferences, from 0 to 60 hours a week. People on the default follow it when it changes.
2. Per person, in Basic info › Capacity.
3. Team › Assignments shows each person's week: hours, utilisation, available capacity (base less time off) and billable hours.
4. Utilisation is tracked hours (billable and non-billable) ÷ capacity. Capacity is spread over working days, so custom ranges are not diluted by weekends.
5. Capacity does not stop anyone tracking more. A capacity change rewrites every past and future week, because there is no history.

**B2B value.** Shows who is overloaded or idle, supports hiring decisions, and gives billable utilisation, the agency KPI.

**Gap.** Timesifier has no expected hours. TS-045's "hours logged against their expected hours from TS-042" is still not ticked.

**B1 · Working week and capacity.** Depends on TS-038 and TS-048. It takes TS-042's first criterion.

- [ ] An owner or admin sets the organisation's working days and hours per day (default Monday to Friday, 7 hours). An owner or admin overrides both for one person from a date. Managers and members cannot (role-table tests).
- [ ] A person's capacity for any range is the sum of their working hours on their working days in it. A change made from a date leaves earlier weeks unchanged, unlike Harvest (property test over random histories).
- [ ] Team's week (TS-045) shows each person's capacity, logged hours and utilisation (logged ÷ capacity, to whole %), and the team's totals (test, including a 0-capacity person shown as "—" and not divided by zero).
- [ ] Nothing stops a person from tracking beyond capacity (test).

**B8 · Utilisation report.** Depends on B1, B4, TS-014a.

- [ ] Reports shows, per person and per team for a range: capacity, logged, billable logged, utilisation and billable utilisation (billable ÷ capacity) (test with known fixtures).
- [ ] Leave reduces capacity as in B3. Utilisation for a person on leave all week shows "—" (test).

---

## 3. Tasks

**Source.** Harvest app: `research/harvest-app/tasks.txt` ("Common tasks: these tasks are automatically added to all new projects", columns Default billable rate and Default assigned people); `projects-new.txt` (Tasks table: each task's assigned teammates and a Billable checkbox per project, "Add a task…", All/None). Help: [Creating, editing, archiving, and deleting tasks][tasks].

**How it works**

1. Manage › Tasks: an admin creates a task with a name, an optional default rate, "billable by default", "common task" (added to every new project) and "add to all existing projects".
2. On a project, the task list is chosen, each task is billable or not _for that project_, and a task can be limited to some of the project's people.
3. A person tracks time to project + task. Reports and invoices group by task.
4. Archiving a task removes it from every project. Time already tracked is kept.

**B2B value.** "What kind of work" separate from "for whom", which is the basis of task rates, task budgets, billable splits and invoices by task.

**B4 · Tasks and billable time.** Depends on TS-011a, TS-012a, TS-012b.

- [ ] An owner or admin keeps the organisation's task list: name, billable by default, common (added to new projects); archive and restore. A manager or member cannot change it (role table).
- [ ] Each project has its tasks. For each project, a task is billable or not. A new project starts with the common tasks (test).
- [ ] A time entry has a task from its project's list. Entries made before this card get a task called "General", added to each existing project by the migration (migration test).
- [ ] An entry is billable when its task is billable on its project. Changing that flag re-rates past entries, as Harvest's bulk action "Set tasks billable" says. Each report shows billable and non-billable hours and their sum (tests).
- [ ] An archived task cannot be chosen for a new entry, and its past entries keep it (test).

---

## 4. Billable rates, project types and currencies

**Source.** Harvest app: `projects-new.txt` (Project type: Time & Materials, Fixed Fee or Non-Billable; Billable rates: No rate, Project, Person or Task rate; "Billing currency: Same as client — GBP"; project code; start and end dates; tags; Invoice values with due date, PO, tax and discount); `person-rates.txt` ("Billable rates … applied to all projects that use their default rate"; "Cost rates … apply to all projects"; "+ New billable rate", "+ New cost rate"); `clients-new.txt` (Preferred currency, invoice due date, tax, second tax, discount per client); `settings-preferences.txt` (Currency GBP, currency and number format). Help: [Project types][types], [Setting billable rates][rates], [Editing billable rates][rateedit], [Different rates per person and task][ratecombo], [Multiple currencies][curr], [Setting and editing cost rates][cost].

**How it works**

1. Each project has one type. _Time & Materials_ bills hours × rate. _Fixed Fee_ bills a set price; its "if billed hourly" column still uses rates. _Non-Billable_ makes every task non-billable.
2. Each project has one rate mode: project rate (one rate for all), person rate (each person's default, or a custom rate on this project), or task rate (the task's default, or a custom rate on this project). Person and task rates cannot be combined; Harvest's workaround is "Jane Programming" tasks.
3. Effective dates exist only for project rates and for person default and cost rates ("+ New rate … effective date"). Task rate edits on a project apply to all past time. A default task rate change reaches only new projects.
4. Currency is set on the account, then the client, then the project. There is no conversion, and one currency per invoice. Cost rates are always in the account currency.
5. Who sees rates: administrators; managers only with a rate permission.

**B2B value.** Turns hours into money: the billable amount per project, the basis for invoices, budgets in fees and profitability. Agencies and consultancies buy for this.

**B5 · Project types and billable rates.** Depends on B4.

- [ ] A project is Hourly (time and materials), Fixed fee (with an amount) or Non-billable. Non-billable makes all its tasks non-billable (test).
- [ ] An hourly or fixed-fee project bills by one of: project rate, person rate (person default, or a project override) or task rate (task default, or a project override) (test per mode).
- [ ] Every rate (project, person default, person-on-project, task-on-project) is stored with an effective-from date. An entry is priced at the rate in force on its own local date, so a rate change never re-prices earlier entries (property test; better than Harvest).
- [ ] An entry's billable amount is hours × rate, rounded to the currency's minor unit only at totals. A report total equals the sum of its rows to the penny (property test).
- [ ] An entry with no rate shows "Missing rate", as Harvest does, and counts 0 in totals. The project page lists those entries (test).
- [ ] The organisation has a currency. A client may override it, and a project may override its client. All amounts carry their currency, and totals are never summed across currencies; a report shows one total per currency (test).
- [ ] Only owner and admin see or edit rates and amounts. Manager visibility is an owner question, recorded on the card (role table).

**B6 · Cost rates and profitability.** Depends on B5. Source also: [Profitability report][profit], `reports-profitability.txt`.

- [ ] An owner or admin gives each person a cost rate per hour with an effective-from date, in the organisation currency (test).
- [ ] The project page and a Profitability report show, for a range: revenue, cost and profit, with margin. Revenue is the billable amount for hourly projects, or the fee spread evenly over the project's start-to-end days for fixed fee. Cost is hours × cost rate plus expenses (B9) (tests with fixtures in Harvest's own worked examples).
- [ ] Only owner and admin see cost and profit (role table).

---

## 5. Project budgets and alerts

**Source.** Harvest app: `projects-new.txt` (Budget: none, total project fees, fees per task, total project hours, hours per task, hours per person; "Budget resets every month"; "Send email alerts if project exceeds 80.00 % of budget"; "Warn team members when they exceed the budget"); `project-page.txt` ("Budget: 50 hours … Budget remaining (100%) 50.00 … Internal costs … Invoiced amount … Uninvoiced amount", tabs Tasks, Team, Invoices, a Hours per week chart); `settings-preferences.txt` ("Count all hours against Total project hours budgets" or only billable). Help: [Project budgets][budget], [Budget email alerts][alerts], [Prevent tracking over budget][overbudget], [Expenses in budget][expbudget].

**How it works**

1. Pick a budget kind and amount. A per-task or per-person budget needs a value on each row; a blank row does not count, and 0 means over at once.
2. "Resets every month" suits retainers.
3. Alerts: at a set % the alert goes out by email the next morning (03:00 US Eastern), then weekly while over. Recipients depend on role and on whether the budget is in fees or hours.
4. "Warn team members" shows a warning when tracking over budget. Tracking is never blocked; Harvest's advice is to archive the project.
5. Expenses count only toward a total-fees budget, and only with "Budget includes billable and non-billable project expenses".

**B2B value.** Catches scope overrun while it can still be fixed, and is the agency's main day-to-day control.

**B7 · Project budgets and alerts.** Depends on B4, B5, TS-049.

- [ ] A project has no budget, or a budget in total hours, hours per task, hours per person, total fees or fees per task, optionally resetting each calendar month in the organisation's time zone (test per kind, including a reset at midnight local).
- [ ] The project page shows spent, remaining and % for the budget's current period. Spent is the sum of entries (hours, or billable amount per B5) in that period (property test).
- [ ] The organisation chooses whether non-billable hours count against hour budgets (test).
- [ ] When spent first crosses the project's alert % (default 80) in a period, each manager of the project and each owner and admin gets one notification (TS-049) and at most one email. Crossing again in the same period sends nothing (test).
- [ ] When "warn when over" is on, a person tracking to an over-budget project sees "This project is over budget" on the Track time sheet, and the entry still saves (test).

---

## 6. Expenses and receipts

**Source.** Harvest app: `expenses.txt` ("Track expenses"; tabs All expenses and Categories; "Record those airline tickets, meals, miles…"); `expenses-categories.txt` (Entertainment, Lodging, Meals, Mileage (£0.70 per mile), Other, Transportation; Edit, Archive, Delete); `settings-preferences.txt` ("Expense reimbursement: Allow reimbursement requests"); `approvals.txt` ("Total expenses … Billable … Non-billable"; "Approve visible timesheets and expenses"). Help: [Tracking expenses][exp], [Managing expense categories][expcat], [Reimbursing expenses][reimb].

**How it works**

1. Expenses › Track expenses: date, project, category, amount (or quantity for a unit-priced category), note, receipt (png, gif, pdf, jpg or jpeg; drag and drop), and "This expense is billable". Expenses on billable projects default to billable.
2. Categories are admin-managed; a unit price such as mileage makes the person enter a quantity. Changing a unit price affects new entries only.
3. Expenses are submitted and approved together with time (you cannot approve only one).
4. Billable expenses can be pulled onto invoices, optionally with an expense report PDF holding the receipt images.
5. Reimbursement: a person flags an expense for reimbursement; an admin pays through Stripe (US and USD only, being rolled out).

**B2B value.** Clients get billed for travel and materials, project costs become true costs, and receipts are kept for the accountant.

**B9 · Expenses.** Depends on TS-011a, TS-046, TS-047.

- [ ] An owner or admin keeps expense categories (name, optional unit price and unit); archive and restore. Changing a unit price applies to expenses dated from the change (test).
- [ ] A person records an expense: date, project, category, amount or quantity, note, billable (defaulting from the project), "reimburse me". Amounts are stored in minor units of the project's currency (test).
- [ ] A receipt (PDF, PNG or JPEG, up to 10 MB) is stored in R2 under an organisation-scoped key. It is served only to people who may see the expense; anyone else gets 404, including people in another organisation (test).
- [ ] Expenses in a period are submitted, withdrawn, approved and returned with the period's time, and are locked with it (test).
- [ ] Reports include an Expenses view and CSV by person, project and category, with billable and reimbursable totals (test).
- [ ] Out of scope, said on the card: paying reimbursements.

---

## 7. Invoices from tracked time and expenses, payments, tax and currencies

**Source.** Harvest app: `invoices-overview.txt` (tabs Overview, Recurring, Retainers, Uninvoiced, Configure; "Total open", "Total paid amount", a chart of invoices issued this year; Open and All; filters Client, Project, dates; columns Status, Due in, Issue date, ID, Client, Balance); `invoice-new-form.txt` ("New invoice for Example Client": "Single invoice / Recurring invoice"; "What projects would you like to invoice?"; "There are no uninvoiced, billable time or expenses for this client"; "Review invoice"); `invoice-edit-demo.txt` (Invoice ID, PO number, issue date, due date (upon receipt, Net 15/30/45/60, custom), client, tax, discount %, currency, subject, line items (item type Product/Service, description, linked project, quantity, unit price, amount), "Total hours", notes with \*bold\* and \_italics\_); `invoice-view.txt` (steps "1 Create invoice, 2 Get paid, 3 Send invoice"; "Record payment", "View history"; attachments "Visible to your clients. Max file size is 10 MB"; "Attach expense report"); `invoices-configure.txt` (Company information, Default values, Appearance, Messages, Field labels, Item types; "E-invoicing: Export invoices in UBL format"); `invoices-defaults.txt` (tax and second tax, time rounding, show total hours, payments due, subject, notes, "Connect Stripe"); `invoices-messages.txt` (send-as address; invoice, reminder and thank-you message templates with `%invoice_id%` variables; "Show payment request option"); `invoices-item-types.txt`; `invoices-appearance.txt` (document title, envelope-window address, columns shown); `reports-invoicing.txt` (Invoiced, Payments received, Receivables, Uninvoiced); `reports-uninvoiced.txt` (per client and project: total hours, uninvoiced hours, uninvoiced expenses, uninvoiced amount, invoiced amount, "Invoice" button); `settings-preferences.txt` ("Deleting invoice line items: time and expenses return to Uninvoiced"; "Invoice approval warnings"); `settings-bulk.txt` (mark as sent, write off, record payment, payment reminders, download as PDF). Help: [Single invoice][inv1], [Time & Materials invoice][invtm], [Fixed fee invoice][invff], [Linking invoices to projects][invlink], [Payments and write-offs][pay], [Multiple taxes][tax], [Sending][send], [Late reminders][late], [Recurring][recur], [Retainers][ret], [Client dashboard][portal], [UBL][ubl], [Peppol][peppol], [Uninvoiced report][uninv].

**How it works**

1. New invoice → client → "for tracked time, expenses, or fixed fees" → choose projects and the date range.
2. For each project, choose how hours appear: one line per project, per task, per person, or detailed (one line per entry, with notes). If the display does not match the rate mode, Harvest uses an effective rate. Choose expenses and their display, and optionally attach the expense report with receipts. Optionally draw from a retainer.
3. Review: the draft carries due terms, PO, tax (two taxes, simple or compound, chosen per line), discount, currency (the project's) and notes. Lines can be edited and added; edits do not change what counts as invoiced.
4. Save as draft, or send by email from notifications@harvestapp.com with a reply-to sender, recipients, a template message, a PDF, a web-invoice link, and a UBL file if enabled. Status goes draft → open → paid, or written off.
5. Entries pulled onto the invoice become _invoiced_ and locked. Deleting a line returns them to uninvoiced, which is an organisation setting.
6. Payments: record a payment with date and amount, including partial payments; delete a wrong one; write off all or part. Online: Stripe or PayPal mark the invoice paid automatically.
7. Late reminders: automatic, "N days late, then every M days", with templates. A thank-you is sent on payment.
8. Reports: invoiced, payments received, receivables (ageing), uninvoiced.
9. Client dashboard: a secret link per client, with no sign-in, showing open invoices and recent payments.
10. Invoice numbers are sequential and editable. Branding covers logo, colours, columns and field labels.

**B2B value.** Closes the loop from time to cash. This is the biggest gap between Timesifier and Harvest, and the reason agencies pay. It needs B4, B5 and B9 under it.

**B10 · Invoices from tracked time and expenses (draft and issue).** Depends on B5, B9, TS-011b, TS-046.

- [ ] Owner or admin only (role table). Choose a client, a date range and its projects. The preview lists uninvoiced billable entries and billable expenses. Entries in periods that are not approved are flagged, not hidden (test).
- [ ] Hours are grouped by project, task or person, or one line per entry. For every grouping, the invoice subtotal equals the sum of the included entries' billable amounts (property test across groupings).
- [ ] A fixed-fee project adds one line for its fee or a chosen part of it (test).
- [ ] Saving creates a draft with the next number in the organisation's sequence. Numbers are unique per organisation and never reused, even after a draft is deleted (test, including two drafts saved at once).
- [ ] Included entries and expenses are marked as invoiced on this invoice. Deleting the draft or one of its lines returns them to uninvoiced (test). An invoiced entry cannot be edited or deleted by anyone until it is released (test).
- [ ] Lines can be edited and free lines added. Free lines change the total but never the invoiced state of any entry (test).
- [ ] An Uninvoiced view lists, per client and project, uninvoiced hours, expenses and amount for a range (test that it equals the billable total minus what is invoiced).
- [ ] An invoice has exactly one currency, the projects' currency. Mixing projects in different currencies is refused (test).

**B11 · Sending, tax, payments and receivables.** Depends on B10, TS-043 (the email ceiling).

- [ ] Organisation invoice settings: legal name, address, tax registration number, default payment terms (on receipt, Net 15/30/45/60, custom days), default notes, and up to two taxes (simple or compound). Per invoice: PO number, discount %, and per-line choice of taxes (tests with UK VAT 20% and a compound case).
- [ ] Totals are computed in integer minor units with one documented rounding rule (round half up per tax line). Subtotal − discount + tax = total for random invoices (property test).
- [ ] Issuing turns draft into open and fixes the number, the issue date and the due date. An open invoice's lines cannot change; it can only be voided, which releases its entries, or credited (test).
- [ ] A PDF of the invoice is produced on the Worker, and its numbers equal the screen's (test comparing extracted text).
- [ ] Send by email to the client's billing contacts, with the PDF and a template subject and body holding the invoice variables. Every send is logged on the invoice's history (test against the email adapter).
- [ ] Record a payment (date, amount, note); partial payments leave a balance; the payment can be deleted; part or all can be written off. Status is open, partly paid, paid or written off, from the payments (property test: balance = total − payments − write-offs ≥ 0).
- [ ] Reports: Invoiced, Payments received, and Receivables by age (current, 1–30, 31–60, 61–90, 90+ days overdue in the organisation's time zone), with CSV (test).
- [ ] Optional late reminder per organisation: N days after due, then every M days, stopped by payment (test with a fake clock).

**B12 · Estimates.** Depends on B11. Source also: `estimates.txt`, `estimates-new.txt` (Estimate ID, PO, issue date, subject, client, tax, discount, currency, line items Product/Service, notes); `estimates-configure.txt`; Help: [Create an estimate][est], [Accept and decline][estacc], [Estimate to project][estproj].

- [ ] Owner or admin creates an estimate: client, number, issue date, subject, lines, tax, discount, notes, currency. The arithmetic is shared with B11 (test).
- [ ] Send it by email with a secret link. The client accepts or declines on the link without signing in, and the status and time are recorded once. A second click changes nothing. An owner or admin can record the decision or revert it (test).
- [ ] An accepted estimate becomes a draft invoice with the same lines (test). Turning an estimate into a project is out of scope, as in Harvest.

**B13 · Recurring invoices and retainers.** Depends on B11.

- [ ] A recurring template (client, lines or "this client's uninvoiced time", frequency monthly, quarterly or yearly, first issue date, end) creates a draft, or an issued and sent invoice, on each date. The 31st becomes the month's last day (test with a fake clock).
- [ ] A retainer per client, or per client and project: a funds invoice adds to it when paid, and a time invoice may draw from it up to its balance. The balance never goes below 0 (property test).

**B14 · Client view and online payment.** Depends on B11. This is later than B10 to B13.

- [ ] A per-client secret link, revocable, shows that client's open invoices and recent payments, and nothing of any other client (test).
- [ ] Stripe Checkout on an open invoice. A verified webhook records the payment once, even if delivered twice (idempotency test).
- [ ] UBL 2.1 XML export of an issued invoice validates against the PEPPOL BIS 3.0 schema (test). Peppol sending is out of scope.

---

## 8. Contractors

**Source.** Harvest app: `people-new.txt` (Type: Employee or Contractor); `reports-contractor.txt` ("Do you work with contractors? … stay on top of their hours and costs"). Help: [Contractor report][contr], [Contractors invoicing me][contrinv], [Occasional freelancers][freel].

**How it works.** Any person can be flagged Contractor, at any role. Reports › Contractor (admins only) shows each contractor's total hours, unrounded, and cost (hours × cost rate) for a range, with archived contractors who tracked in that range. Contractors cannot invoice the company from inside Harvest; the Deel integration copies their time to Deel.

**B2B value.** Shows what to pay subcontractors and lets you check their bills against tracked time.

**B15 · Contractors.** Depends on B6.

- [ ] An owner or admin marks a member as employee or contractor (test).
- [ ] A Contractors report lists each contractor's unrounded hours and cost for a range, including people who left the organisation if they tracked in it, with CSV. Owner and admin only (role table).

---

## 9. Roles and permissions

**Source.** Harvest app: `person-permissions.txt` (six profiles with Harvest's own wording: Member, Project Manager, People Admin, Accounting, Executive Manager, Administrator); `person-projects.txt`; `person-teammates.txt` ("As an Administrator, you can report on, approve, and edit all people"). Help: [Permissions][perm] (six built-in roles; custom roles built from any of them by ticking permissions in 12 categories: Time, Expenses, Projects, Time off, Clients & Tasks, People, Rates, Invoices, Estimates, Reports, Approvals, Account; up to 50 custom roles; prerequisites switched on together), [Assigned people for managers][assign].

**How it works.** Each person has one role. Scope is "own", "managed" (assigned people or managed projects) or "all", per category. Rates, invoices and reports are each a separate grant.

**B2B value.** Finance staff can invoice without seeing HR data, and HR can manage leave without seeing rates. Larger customers ask for this.

**Gap and stance.** `docs/navigation.md` "Deliberately not copied" keeps owner, admin, manager and member, and custom roles wait for a customer. Invoicing changes the case: it brings money data a manager should not see by default, and a bookkeeper who needs invoices without being an admin. I propose one built-in role and keep custom roles out.

**B16 · Finance role.** Depends on B10. It reopens one line of "Deliberately not copied", so the owner decides.

- [ ] A role "Finance": sees all time and expenses (read-only), all rates, all invoices, estimates and payments, and every report. It cannot manage members, teams, leave policies or workspace settings (a test for every cell of the extended role table).
- [ ] Every existing route's role test gains a Finance column (test inventory).

---

## 10. Activity log

**Source.** Harvest app: `reports-activity.txt` (tabs Timesheets, Approvals, Projects, Expenses, Invoices, Clients; filters Clients, Projects, Tasks, Event types, Owned by, Performed by; Export); `settings-modules.txt` (Activity log, Enterprise). Help: [Activity log overview][alog] (6 months kept, a module that is off by default), [Timesheets log][alogts] (create, delete, timer start and stop, edits with before and after, who did it and whose timesheet, bulk moves, marked invoiced; badges "via API", "via import", "via bulk action"), [Projects log][alogproj].

**B2B value.** Settles disputes ("who changed my hours?"), supports clients who audit billed time, and gives SOC 2-style evidence.

**Gap.** TS-020 covers security events only (sign-in, role, invitation, export, deletion).

**B17 · Activity log**, extending TS-020. Depends on TS-020, TS-046.

- [ ] Creating, editing (with the changed fields' old and new values), deleting, starting and stopping a timer on a time entry, and every period action each write a record with actor, owner of the entry, organisation and source (web, import, API) (test per action).
- [ ] Projects, clients, rates, budgets, leave decisions, and (with B10) invoices, payments and sends write records (test per kind).
- [ ] Reports › Activity shows records for a range, filtered by kind, project, "performed by" and "owned by", with CSV. Owner and admin see all; a manager sees records about their teams' people; a member sees records about their own entries (role table).
- [ ] Entry text (descriptions) is never copied into a record, as TS-020 says. Edits record that the description changed, not what it said (test).
- [ ] The retention period is written in `docs/security.md`. The owner chooses whether it is longer than Harvest's 6 months.

---

## 11. Saved reports, custom reports and dashboards

**Source.** Harvest app: `reports-saved.txt` (All, Your reports, Shared with you; "Custom only"); `reports-detailed.txt` (timeframe; clients, projects, tasks and teammates filters; "Show: Billable - Non-Billable", "Show: Invoiced - Non-Invoiced", "Group by: Client", "Active projects only", Save report, Export, print); `dashboards.txt`. Help: [Custom report][custom] (up to 6 grouping fields, metrics, live preview; share as "can view" or "can edit"; CSV, with large exports emailed), [Dashboards][dash].

**B2B value.** A manager reruns "billable hours by client this month" in one click, and a team shares the same view.

**B18 · Saved and shared reports.** Depends on TS-014a, TS-014b.

- [ ] Any report view (range kind, filters, grouping) can be saved under a name. Reopening it reruns it against today's data, with a relative range such as "last month" moving with the date (test with a fake clock).
- [ ] The owner of a saved report shares it with named people as view or edit. A recipient sees only the rows their own role allows, never the sharer's scope (test: a member opening an admin's shared report sees only their own hours).
- [ ] Out of scope: dashboards and a custom-metric builder.

---

## 12. Import and export

**Source.** Harvest app: `settings-import-export.txt` ("Import time", "Import expenses", "Revert an import", "Export all time", "Export all invoices"; "projects, people, and clients" are imported and exported from their own pages); `team-assignments.txt` (Import and Export buttons on Team; "Employee IDs … bulk import them via CSV"). Help: [Importing data][imp] (time CSV columns: Date, Client, Project, Task, Notes, Hours, First name, Last name; creates missing clients, projects and tasks, never people; no updates), [Exporting data][expt].

**B2B value.** Switching from Harvest, Toggl or Clockify in an afternoon is the main way a team adopts Timesifier. Full export answers "can we leave?" in procurement.

**B19 · Import time from a CSV, and revert it.** Depends on B4, TS-014b.

- [ ] An owner or admin uploads a CSV with Harvest's 8 columns (Harvest's own "Export all time" is accepted as is). Each row is matched to a member by email or name. Missing clients, projects and tasks are created. Unmatched people are listed with their rows and nothing from them is imported (test with a fixture of Harvest's export).
- [ ] A preview shows the rows to import and the rows to skip, with reasons, before anything is written (test).
- [ ] Each import has an id. "Revert" deletes exactly that import's entries unless one is in an approved or invoiced period, in which case it refuses and names those entries (test).
- [ ] Rows already present (same person, date, project, task, hours and notes) are skipped (test).
- [ ] Clients and projects import from a CSV on their own pages (test).

**TS-014b**, amended: an owner or admin can export all of the organisation's time, and with B10 all invoices as one ZIP of PDFs (test).

---

## 13. Integrations

**Source.** Harvest app: `integrations.txt`. Categories: AI connectors (ChatGPT, Claude); Project management (Asana, Forecast, Basecamp, ClickUp, GitHub, Jira, Linear, Monday, Notion, Trello); Finance and payments (Stripe, Deel, PayPal, QuickBooks, Xero, Gusto); Communication and CRM (Google Workspace, Slack, Zendesk); Productivity (Google Calendar, Outlook.com); Development and connectivity (IFTTT, Relay, Zapier); Browser extensions (Chrome, Edge, Firefox); OAuth2 API clients and a public API. Help: [Xero][xero], [QuickBooks Online][qbo], [Google Calendar and Outlook][gcal].

**B2B value, ranked for Timesifier's buyers:**

1. Accounting: invoices to Xero or QuickBooks.
2. Calendar: leave out (B3's ICS feed), meetings in (TS-016).
3. Slack: reminders and "who is off".
4. A public API with tokens, which Zapier and others then build on.
5. Browser extensions in Jira, GitHub and Linear.

**B20 · Public API with organisation tokens.** Depends on TS-020.

- [ ] An owner or admin creates and revokes API tokens. A token is shown once and stored hashed, and acts with a role chosen at creation (member, manager or admin) (test).
- [ ] Read endpoints for projects, clients, tasks, time entries and leave, and write endpoints for time entries, obey the same role rules as the pages (shared role-table test). Writes appear in the activity log "via API" (test).
- [ ] A rate limit per token. Exceeding it returns 429 with Retry-After (test).

**B21 · Xero export.** Depends on B11. A connector card per provider follows the same shape.

- [ ] An owner or admin connects Xero by OAuth. Issuing an invoice in Timesifier creates the same invoice (contact, lines, tax, currency, number) in Xero once, and a retry never duplicates it (idempotency test against a recorded fixture).
- [ ] A payment recorded in Xero is read back and recorded on the Timesifier invoice (test).

---

## 14. Timesheet locking and the deadline

**Source.** Harvest app: `approvals.txt` ("Time and expenses are still editable … You can set a recurring auto-lock from Settings or apply a one-time manual lock … Apply one-time manual lock"); `preferences-edit.txt` (Timesheet deadline: no preference, weekly, 15th of the month, end of the month, custom; Auto-lock "only available when a timesheet deadline is set"; Auto-submit; "Remind my team to enter time for the deadline"; "Manager self-approval"; "Invoice approval warnings"); `notification-settings.txt` ("Timesheet locking: your tracked time becomes locked for a period"). Help: [Understanding Timesheet Lock][lock] (one company-wide lock date; auto-lock fires N days after each deadline and never moves the date earlier; a manual lock date can be any date up to today, optionally auto-submitting what is unsubmitted, and can be removed), [Timesheet reminders][remind].

**B2B value.** Payroll and month-end close need a date after which hours cannot move, even for people who never submit.

**Stance.** `docs/harvest-comparison.md` dropped the manual lock because approval already locks a period. That covers only people who submit. A lock date also covers people who never submit, and the owner and admins.

**B22 · Deadline and lock date.** Depends on TS-046, TS-047.

- [ ] An owner or admin sets a timesheet deadline (weekly on a day and time, or monthly on a date, in the organisation's time zone) (test).
- [ ] An owner or admin sets a lock date up to today. No entry, expense or leave on or before it can be created, edited or deleted by anyone, owner included, until the lock date is moved back, which is recorded (test per role).
- [ ] Optional auto-lock: N days after each deadline, the lock date moves forward to the deadline. It never moves backward (test with a fake clock).
- [ ] Optional auto-submit at lock: every unsubmitted period up to the lock date becomes submitted, recorded as "submitted by the system" (test).

## 15. Reminders and notifications

**Source.** Harvest app: `notification-settings.txt`. Personal daily reminders run at a chosen time on chosen weekdays, by pop-up or Slack. A weekly email covers my time. Each event has in-app and email switches: timesheet submitted for someone I manage, timesheet submitted for a project I manage, timesheet approved, timesheet locking, time tracking reminder, time-off request, request reviewed, request cancelled, invoice paid, expense reimbursement request, bulk action finished. Help: [Timesheet reminders][remind] (company reminders before and after the deadline, to "anyone who tracked less than X% of capacity" or "anyone who hasn't submitted"; one-off reminders from Unsubmitted; personal reminders), [All notifications][notif].

**TS-049**, amended with these criteria. Depends on TS-046, TS-047, B1.

- [ ] A person sets a daily reminder (time and weekdays, in their time zone). It is sent only on a working day (B1), not on leave (TS-040) or a holiday, and only if they have tracked nothing that day (test with a fake clock).
- [ ] An owner or admin turns on deadline reminders: X hours before and Y hours after the deadline (B22), to people under Z% of capacity or not submitted. People on leave for the whole period are skipped (test).
- [ ] Each notification kind (period submitted, decided, returned; leave requested, decided, cancelled; budget alert; invoice paid) has an in-app and an email switch per person, with in-app on and email off by default except approval requests (test).

---

## 16. Other things seen

- **Bulk actions** (`settings-bulk.txt`): set rates, assign to or remove from projects, add or remove tasks and tags, set tasks billable (re-rates past hours), archive and reactivate people, clients, projects and tasks, update people (roles, departments, capacity, working hours, time zone, employee ID), update projects, invoice bulk actions (mark sent, write off, record payment, reminders, delete, PDF ZIP), and delete time entries, expenses and contacts. No card yet. Bring individual bulk actions in only when a page needs them.
- **Sign-in security** (`settings-signin.txt`): require 2FA, require Google sign-in, and SAML (Enterprise only). Timesifier's sign-in is code-based (TS-036). "Require sign-in with Google or Microsoft for this organisation" and SAML are later cards for larger buyers.
- **Company preferences** worth matching later (`preferences-edit.txt`): time rounding for invoices and summary reports, never for timesheets; "Require notes for all time entries" (Enterprise); a decimal or HH:MM display; a fiscal-year start that adds "This fiscal year" to reports; currency and number format.
- **Project details** (`projects-new.txt`): project code, start and end dates, tags, notes visible to admins only, "Show project report to everyone on this project". These are small additions to TS-011a, and fit after B5.

---

## Recommended build order

Leave is first because the owner asked for it by name. Rates and tasks come before money features because every money feature reads them. Each row's criteria are above.

| #   | Card                                       | Depends on                 | Why here                                                                                                     |
| --- | ------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | B1 Working week and capacity               | TS-038, TS-048             | Leave counts working days. TS-045's expected hours wait for it. Small, with no money in it.                  |
| 2   | TS-040 Leave (amended)                     | TS-038, B1                 | The owner's first ask: types, requests, approval, on the timesheet.                                          |
| 3   | TS-042 Policies (amended)                  | TS-040, B1                 | Balances, accrual, carry-over, holidays.                                                                     |
| 4   | B2 Who is off now                          | TS-040, TS-045             | The owner's "live on leave" status. Read-only and cheap once TS-040 exists.                                  |
| 5   | TS-041 Team calendar (amended)             | TS-040, TS-013             | Seeing overlaps before approving.                                                                            |
| 6   | B3 Leave in reports and capacity, ICS feed | TS-042, B1, TS-014a        | Closes leave end to end: balances report, capacity net of leave, calendar feed.                              |
| 7   | TS-049 Reminders (amended)                 | TS-046, TS-047, B1         | Reminders that skip people on leave. Needed by B7's alerts.                                                  |
| 8   | B22 Deadline and lock date                 | TS-046, TS-047             | Payroll close. Leave and expenses respect it.                                                                |
| 9   | B4 Tasks and billable time                 | TS-011a, TS-012a, TS-012b  | The base of every money feature.                                                                             |
| 10  | B5 Project types, billable rates, currency | B4                         | Turns hours into amounts, with effective dates.                                                              |
| 11  | B8 Utilisation report                      | B1, B4, TS-014a            | Billable utilisation, the agency KPI.                                                                        |
| 12  | B7 Budgets and alerts                      | B4, B5, TS-049             | The agency's daily control.                                                                                  |
| 13  | B9 Expenses and receipts                   | TS-011a, TS-046, TS-047    | Needed before invoices can bill them. R2 for receipts.                                                       |
| 14  | B6 Cost rates and profitability            | B5 (B9 for expense costs)  | Margin per project.                                                                                          |
| 15  | B17 Activity log (extends TS-020)          | TS-020, TS-046             | Should exist before invoicing, so that billed time has a history.                                            |
| 16  | B10 Invoices from time and expenses        | B5, B9, TS-011b, TS-046    | Time to money, the core B2B gap.                                                                             |
| 17  | B11 Sending, tax, payments, receivables    | B10, TS-043                | Makes invoices usable for real.                                                                              |
| 18  | B16 Finance role                           | B10 (owner decision)       | A bookkeeper invoices without being an admin.                                                                |
| 19  | B19 Import (CSV, revert); TS-014b export   | B4, TS-014b                | Switching from Harvest or Toggl. It can move earlier, right after B4, if growth matters more than invoicing. |
| 20  | B12 Estimates                              | B11                        | Quote, then invoice.                                                                                         |
| 21  | B13 Recurring invoices and retainers       | B11                        | Retainer agencies.                                                                                           |
| 22  | B15 Contractors                            | B6                         | Paying subcontractors.                                                                                       |
| 23  | B18 Saved and shared reports               | TS-014a, TS-014b           | Repeatable reporting.                                                                                        |
| 24  | B20 Public API                             | TS-020 (B17 for "via API") | Unlocks Zapier and customers' scripts.                                                                       |
| 25  | B14 Client view, Stripe, UBL               | B11                        | Getting paid faster; EU e-invoicing.                                                                         |
| 26  | B21 Xero export (then QuickBooks)          | B11                        | Accountants.                                                                                                 |

```
TS-038 ─┬─ B1 ─┬─ TS-040 ─┬─ TS-042 ── B3
        │      │          ├─ B2
        │      │          └─ TS-041
        │      ├─ TS-049 ── B7
        │      └─ B8
TS-046/047 ─┬─ B22
            ├─ B9 ──┐
            └─ B17  │
TS-011a ── B4 ── B5 ┼─ B6 ── B15
                    ├─ B7
                    └─ B10 ── B11 ─┬─ B12, B13, B14, B21
                           └─ B16
```

## Harvest behaviour Timesifier should not copy

| Harvest behaviour                                                                                        | Source                  | What Timesifier should do instead                                               |
| -------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| Changing a capacity rewrites every past week.                                                            | [cap]                   | B1 dates every change.                                                          |
| A task rate edited on a project re-prices past time; a new default task rate needs a duplicated project. | [rateedit]              | B5 dates every rate.                                                            |
| Person and task rates cannot be combined on one project.                                                 | [ratecombo]             | Keep one mode in B5. A person-on-task matrix can come later if a customer asks. |
| No currency conversion.                                                                                  | [curr]                  | Same. Totals are per currency and never summed across currencies.               |
| Budget alerts arrive the next morning at 03:00 US Eastern.                                               | [alerts]                | B7 notifies when the threshold is crossed.                                      |
| Activity log kept for only 6 months, as an Enterprise module.                                            | [alog]                  | B17 is on for everyone. The owner sets the retention.                           |
| Sample data and a sample invoice created by Harvest on first visit (observed here).                      | `invoice-edit-demo.txt` | Already a "does not take" in `docs/harvest-comparison.md`.                      |

## Questions for the owner that these cards raise

1. Leave unit (days with half days is proposed), the seed types, and approval per type (TS-040).
2. Accrual default (up front is proposed) and the leave-year start (1 January is proposed) (TS-042).
3. Whether members see who in their team is on leave, or only managers do (TS-041 and B2).
4. Whether a lock date (B22) and a Finance role (B16) reopen the two "Deliberately not copied" lines.
5. Whether managers see rates and amounts for their teams (B5).
6. Activity-log retention (B17).
7. Whether import (B19) moves ahead of invoicing for growth.

[to]: https://support.getharvest.com/hc/en-us/articles/360048687511-How-do-I-track-time-off-PTO-vacation-or-sick-days
[cap]: https://support.getharvest.com/hc/en-us/articles/360048181752-Setting-and-editing-capacity
[capstop]: https://support.getharvest.com/hc/en-us/articles/12916638768909-Can-I-stop-my-team-from-tracking-more-than-their-set-capacity
[util]: https://support.getharvest.com/hc/en-us/articles/43000673746445-Utilization-rate-in-Detailed-Time-report
[tasks]: https://support.getharvest.com/hc/en-us/articles/360048181332-Creating-editing-archiving-and-deleting-tasks
[types]: https://support.getharvest.com/hc/en-us/articles/360048686931-What-s-the-difference-between-Time-Materials-Fixed-Fee-and-Non-Billable-projects
[rates]: https://support.getharvest.com/hc/en-us/articles/360048181492-Setting-billable-rates
[rateedit]: https://support.getharvest.com/hc/en-us/articles/12522267831181-Editing-billable-rates
[ratecombo]: https://support.getharvest.com/hc/en-us/articles/360052713051-My-teammates-have-different-billable-rates-for-the-different-types-of-work-they-do-How-can-I-represent-that-in-Harvest
[cost]: https://support.getharvest.com/hc/en-us/articles/360048687391-Setting-and-editing-cost-rates
[curr]: https://support.getharvest.com/hc/en-us/articles/360055384512-Does-Harvest-support-multiple-currencies
[profit]: https://support.getharvest.com/hc/en-us/articles/25342727197581-Profitability-report
[budget]: https://support.getharvest.com/hc/en-us/articles/360048686811-How-to-set-project-budgets
[alerts]: https://support.getharvest.com/hc/en-us/articles/4407283487629-Budget-email-alerts
[overbudget]: https://support.getharvest.com/hc/en-us/articles/4407035124749-Can-I-prevent-my-team-from-tracking-to-a-project-that-s-over-budget
[expbudget]: https://support.getharvest.com/hc/en-us/articles/360052763131-How-do-I-include-expenses-in-my-project-budget
[exp]: https://support.getharvest.com/hc/en-us/articles/360048687611-Tracking-expenses
[expcat]: https://support.getharvest.com/hc/en-us/articles/360048686731-Managing-expense-categories
[reimb]: https://support.getharvest.com/hc/en-us/articles/47728570243597-Reimbursing-expenses-within-Harvest
[inv1]: https://support.getharvest.com/hc/en-us/articles/360048686371-How-to-create-a-single-invoice
[invtm]: https://support.getharvest.com/hc/en-us/articles/4411230158221-How-do-I-invoice-for-my-Time-Materials-project
[invff]: https://support.getharvest.com/hc/en-us/articles/4411230292877-How-do-I-invoice-for-my-Fixed-Fee-project
[invlink]: https://support.getharvest.com/hc/en-us/articles/360048686631-Linking-invoices-to-projects
[pay]: https://support.getharvest.com/hc/en-us/articles/360048181032-Recording-and-removing-invoice-payments-and-write-offs
[tax]: https://support.getharvest.com/hc/en-us/articles/5635919437709-Can-I-apply-multiple-taxes-to-an-invoice
[send]: https://support.getharvest.com/hc/en-us/articles/360048686471-Sending-invoices-and-estimates
[late]: https://support.getharvest.com/hc/en-us/articles/18013752929293-Late-invoice-reminder-messages
[recur]: https://support.getharvest.com/hc/en-us/articles/360048181052-Recurring-invoices
[ret]: https://support.getharvest.com/hc/en-us/articles/360048180992-How-to-create-and-draw-from-a-retainer
[portal]: https://support.getharvest.com/hc/en-us/articles/360048181172-Using-the-client-dashboard
[ubl]: https://support.getharvest.com/hc/en-us/articles/34089844964749-UBL-XML-exports-for-e-invoicing-in-Europe
[peppol]: https://support.getharvest.com/hc/en-us/articles/47891690874253-E-invoicing-with-Peppol
[uninv]: https://support.getharvest.com/hc/en-us/articles/360048687231-Uninvoiced-report
[est]: https://support.getharvest.com/hc/en-us/articles/360048180972-How-to-create-an-estimate
[estacc]: https://support.getharvest.com/hc/en-us/articles/360048686351-Accepting-and-declining-estimates
[estproj]: https://support.getharvest.com/hc/en-us/articles/360048181192-Can-I-convert-an-estimate-to-a-project
[contr]: https://support.getharvest.com/hc/en-us/articles/360048687271-Contractor-report
[contrinv]: https://support.getharvest.com/hc/en-us/articles/360048181252-Can-contractors-invoice-me-using-the-time-they-ve-tracked-in-my-account
[freel]: https://support.getharvest.com/hc/en-us/articles/360053266771-How-do-I-add-time-for-occasional-freelancers-contractors-or-external-vendors
[perm]: https://support.getharvest.com/hc/en-us/articles/44171549176077-Permissions
[assign]: https://support.getharvest.com/hc/en-us/articles/4422314817677-Making-people-assignments-for-Managers
[alog]: https://support.getharvest.com/hc/en-us/articles/20100531286157-Activity-log-overview-and-FAQ
[alogts]: https://support.getharvest.com/hc/en-us/articles/20100321217933-Activity-log-Timesheets
[alogproj]: https://support.getharvest.com/hc/en-us/articles/34910656069133-Activity-log-Projects
[custom]: https://support.getharvest.com/hc/en-us/articles/46653058359053-Creating-a-custom-report
[dash]: https://support.getharvest.com/hc/en-us/articles/49057982486669-Dashboards
[imp]: https://support.getharvest.com/hc/en-us/articles/360048685111-Importing-data
[expt]: https://support.getharvest.com/hc/en-us/articles/31625325401229-Exporting-data
[xero]: https://support.getharvest.com/hc/en-us/articles/360048180752-Xero
[qbo]: https://support.getharvest.com/hc/en-us/articles/360048686231-QuickBooks-Online
[gcal]: https://support.getharvest.com/hc/en-us/articles/360048180932-Google-Calendar-and-Outlook-com-Calendar-Add-calendar-events-to-your-timesheet
[lock]: https://support.getharvest.com/hc/en-us/articles/46563687732877-Understanding-Timesheet-Lock
[remind]: https://support.getharvest.com/hc/en-us/articles/360058596112-Timesheet-reminders
[notif]: https://support.getharvest.com/hc/en-us/articles/360053255031-What-are-all-the-notifications-emails-Harvest-sends-and-how-do-I-enable-disable-each-one
