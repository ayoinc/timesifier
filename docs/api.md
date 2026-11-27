# The Timesifier API

<!-- Cards TS-081 (the API), TS-087 (webhooks) and TS-089 (calendar feeds). The code is `app/integrations/api.server.ts`. This file is published as it is at /developers/api (TS-106, app/routes/developers.api.tsx), so it is written for the people who use the API; a comment like this one is left off the page. -->

The same API is described for tools in [`openapi.yaml`](openapi.yaml), which anyone may download without a token.

## Tokens

An owner or admin makes a token on **Integrations › API tokens › Create token**. It is shown once and starts `tsf_`. Send it with every request:

```
Authorization: Bearer tsf_…
```

A token acts as the person who made it, with their role and teams as they are at each request. It never reaches more than that person could on the pages; the scopes chosen when it was made narrow it further:

| Scope               | Lets the token                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `time:read`         | Read time entries, and `GET /me`                                                            |
| `time:write`        | Add, change and delete the maker's own time entries                                         |
| `descriptions:read` | Read entry descriptions and expense notes                                                   |
| `projects:read`     | Read projects, their teams and time shares, work packages, clients and tasks                |
| `projects:write`    | Assign people to projects' teams, change and end their stretches, and set their time shares |
| `people:read`       | Read people and their leave                                                                 |
| `expenses:read`     | Read expenses                                                                               |
| `invoices:read`     | Read invoices                                                                               |

A token that is revoked, has expired, or whose maker has left the organisation is answered `401`.

## Rate limit

A token may make 100 requests in any 15 seconds. The next is answered `429 Too Many Requests` with `Retry-After`, the seconds to wait.

## Answers

Everything is JSON. A list is `{ "data": [ … ] }`; a list that pages adds `"next_cursor"`, which is passed back as `?cursor=` for the next page, and takes `?per_page=` up to 100. Times are ISO 8601 in UTC; days are `YYYY-MM-DD`; money is in minor units (`total_minor: 12550` is 125.50) with its `currency`.

An error is `{ "error": { "code", "message" } }`, and for `422` also `"fields"`, each field's problem:

| Status | Code                     | When                                                                                    |
| ------ | ------------------------ | --------------------------------------------------------------------------------------- |
| 400    | `bad_json`               | The body is not JSON                                                                    |
| 401    | `unauthorized`           | No working token                                                                        |
| 403    | `insufficient_scope`     | The token lacks the scope                                                               |
| 403    | `forbidden`              | The maker's role may not do it, or it is someone else's entry                           |
| 404    | `not_found`              | Nothing at that address, or nothing the maker may see there                             |
| 405    | `method_not_allowed`     | `Allow` says which methods are                                                          |
| 409    | `locked`, `running`      | The day is locked (submitted, approved, lock date), or the entry is running             |
| 409    | `invoiced`               | The entry is on an invoice; `message` names it and who can let it go                    |
| 409    | `overlaps`               | Two stretches of a person on a team, or two time shares on one line, would share a day  |
| 409    | `has_time`               | A stretch taken away from a team has time on the project                                |
| 413    | `too_large`              | A body over 16 KB                                                                       |
| 415    | `unsupported_media_type` | A body that is not `application/json`                                                   |
| 422    | `invalid`                | Values that cannot be used                                                              |
| 422    | `ends_before_start`      | A stretch on a team, or a time share, that ends before it starts                        |
| 422    | `not_member`             | A person put on a team, or given a time share, who is not a member of the organisation  |
| 422    | `amount`                 | A time share of none, or of more than 7 days or 168 hours a week, or 100% of a schedule |
| 422    | `work_package`           | A time share of a work package that is not one of the project's                         |
| 429    | `rate_limited`           | See above                                                                               |

## Who sees what

The pages' rules (`docs/security.md`, "Whose time", "Rates and money"):

| Role                     | Entries and expenses                | People               | Clients | Invoices | Project money | Leave kind     |
| ------------------------ | ----------------------------------- | -------------------- | ------- | -------- | ------------- | -------------- |
| Owner, admin             | Everyone's                          | Everyone, with email | Yes     | Yes      | Yes           | Everyone's     |
| Finance                  | Everyone's                          | Everyone             | Yes     | Yes      | Yes           | Their own      |
| Manager (manages a team) | Their own and their teams' members' | Themselves and teams | No      | No       | No            | Own and teams' |
| Member, contractor       | Their own                           | Themselves           | No      | No       | No            | Their own      |

Everyone sees approved leave of everyone, as the live "not working" status does; requests not yet approved only their own. Every role writes only its own entries. Who sees and changes a project's team is under `GET /project_members`; who sees and sets time shares, under `GET /allocations`.

## Endpoints

All under `https://timesifier.com/api/v1`.

### `GET /me`

The token's maker, organisation, role and scopes.

### `GET /users` — `people:read`

Query: `per_page`, `cursor`. By `id`. `id`, `name`, `role`, `is_contractor`; `email` for an owner's or admin's token.

### `GET /clients` — `projects:read`

`id`, `name`, `code` (`ACME`, or null), `archived`, `currency`. For those shown Clients.

### `GET /projects` — `projects:read`

`id`, `name`, `code` (`ACME-001`, or null), `client` (`{ id, name, code }` or null), `archived`; for those who see money also `billing_type`, `rate_mode`, `fee_minor`, `currency`, `budget`.

A client's or project's `code` is how the organisation refers to it, and is unique in the organisation whatever its letters' case. Wherever an answer names a client, project or work package, it gives `{ id, name, code }`.

### `GET /tasks` — `projects:read`

`id`, `name`, `archived`, `billable_by_default`, `common`, and `projects`: `[{ id, billable }]`.

### `GET /work_packages` — `projects:read`

Query: `project_id`. Each project's work packages (TS-115b), archived ones too, by project then code: `id`, `project_id`, `code` (`WP2`, unique in its project whatever its letters' case), `name`, `starts_on`, `ends_on`, `state` (`open` or `closed`), `billable`, `archived`, and `budget` (`{ kind, amount }`: `hours` in minutes for everyone, `fees` in minor units only for those who see money; null otherwise).

While a project has an open work package, every new or changed entry of it names one, open and of that project; a closed one takes no new time, and the time already on it stays. Entries from before keep what they have.

### `GET /project_members` — `projects:read`

Query: `project_id`, `user_id`, `per_page`, `cursor`. By `id`. Each stretch of a person on a project's team (TS-115c): where the organisation lets only the people on a project's team track time to it, a person's time on a day goes to the project only while one of their stretches covers that day.

```json
{
	"id": "0193…",
	"project_id": "…",
	"user": { "id": "…", "name": "Ada Lovelace" },
	"role": "delivery_manager",
	"starts_on": "2026-11-02",
	"ends_on": null,
	"source": "manual"
}
```

`role` is `member` or `delivery_manager`; `ends_on` is the stretch's last day, null while it runs on; `source` is what made it: `manual`, `import` or `contract`. No two stretches of one person on one project share a day. Owners, admins, Finance, managers of teams, the client's account managers and the project's delivery managers see its whole team; anyone else sees only their own stretches. A `project_id` that is not the organisation's answers `404`.

### `GET /project_members/{id}` — `projects:read`

One stretch, or 404 where the maker may not see it.

### `POST /project_members` — `projects:write`

```json
{
	"project_id": "…",
	"user_id": "…",
	"role": "member",
	"starts_on": "2026-11-02",
	"ends_on": "2027-03-31"
}
```

`201` with the stretch. `ends_on` left out or null, the stretch runs on. Owners, admins, the client's account managers and the project's delivery managers put people on its team; only owners, admins and the client's account managers name a delivery manager. Anyone else is answered `403` `forbidden`. A stretch that shares a day with another of the person's on the project answers `409` `overlaps`; one that ends before it starts `422` `ends_before_start`; a person who is not a member of the organisation `422` `not_member`.

### `PATCH /project_members/{id}` — `projects:write`

Either `{ "ends_on": "2026-12-31" }` (null: it runs on) or `{ "role": "delivery_manager", "from": "2026-12-01" }`. A role changed from the stretch's first day, or before, is the stretch's own; from a later day, the stretch ends the day before and a new one of the new role runs on to where it ran, and the answer is that new stretch. The same people as for `POST` change a stretch; a delivery manager's, only owners, admins and the client's account managers.

### `DELETE /project_members/{id}` — `projects:write`

`204`. Takes away a stretch put there in error. One in which its person has tracked time to the project answers `409` `has_time`: end it instead, so the time it let in stays explained.

### `GET /allocations` — `projects:read`

Query: `user_id`, `project_id`, `from`, `to` (days, both included: the shares that run on any day between them; left out, every share), `per_page`, `cursor`. By `id`. Each time share (TS-116): so many days or hours a week, or a percentage of the person's schedule, of a project or of one of its work packages, from a day to a day or on. What it plans on a day is read from the person's work schedule that day, less public holidays and approved leave.

```json
{
	"id": "0193…",
	"user_id": "…",
	"project_id": "…",
	"work_package_id": null,
	"starts_on": "2026-11-02",
	"ends_on": null,
	"amount": 2.5,
	"unit": "days",
	"amount_text": "2.5 days a week"
}
```

`work_package_id` is null for a share of the whole project. `amount` is in its `unit`: `days` a week (up to 7), `hours` a week (up to 168; `22.5` is 22:30) or `percent` of the person's schedule (up to 100), to two decimal places; `amount_text` says it in words (`22:30 a week`, `50% of their schedule`). `ends_on` is the share's last day, null while it runs on. No two shares of one person on one line, the project or one work package, share a day. Owners and admins see every share; anyone else sees their own, those of the people in teams they manage, and every share on the projects they lead as delivery manager or whose client they are account manager of. A `project_id` that is not the organisation's answers `404`.

### `GET /allocations/{id}` — `projects:read`

One share, or 404 where the maker may not see it.

### `POST /allocations` — `projects:write`

```json
{
	"user_id": "…",
	"project_id": "…",
	"work_package_id": "…",
	"starts_on": "2026-11-02",
	"ends_on": "2027-03-31",
	"amount": 22.5,
	"unit": "hours"
}
```

`201` with the share. `work_package_id` left out or null, it is a share of the whole project; `ends_on` left out or null, it runs on. Owners, admins, the client's account managers and the project's delivery managers set its time shares; anyone else is answered `403` `forbidden`. A share that shares a day with another of the person's on the same line answers `409` `overlaps`; one that ends before it starts `422` `ends_before_start`; an amount of none or more than the unit holds `422` `amount`; a work package of another project `422` `work_package`; a person who is not a member of the organisation `422` `not_member`.

### `PATCH /allocations/{id}` — `projects:write`

Either `{ "ends_on": "2026-12-31" }` (null: it runs on) or `{ "amount": 50, "unit": "percent", "from": "2026-12-01" }` (`from` left out, the share's first day). An amount changed from the share's first day, or before, is the share's own; from a later day, the share ends the day before and a new one of the new amount runs on to where it ran, so the weeks before keep their plan, and the answer is that new share. The same people as for `POST` change a share.

### `DELETE /allocations/{id}` — `projects:write`

`204`. Removes a share, all of its days. To keep the weeks already planned, end it instead.

### `GET /time_entries` — `time:read`

Query: `from`, `to` (days, at most 366 apart, both included, matched against each entry's `spent_date`), `user_id`, `project_id`, `per_page`, `cursor`. Newest first.

```json
{
	"id": "0193…",
	"user": { "id": "…", "name": "Ada Lovelace" },
	"project": { "id": "…", "name": "Apollo", "code": "INI-001" },
	"client": { "id": "…", "name": "Initech", "code": "INI" },
	"task": { "id": "…", "name": "Design" },
	"work_package_id": "…",
	"work_package": { "id": "…", "name": "Build", "code": "WP2" },
	"spent_date": "2026-11-03",
	"started_at": "2026-11-03T09:00:00.000Z",
	"ended_at": "2026-11-03T10:30:00.000Z",
	"running": false,
	"hours": 1.5,
	"overtime": false,
	"billable": true,
	"description": "Pairing",
	"import_id": null,
	"created_at": "…",
	"updated_at": "…"
}
```

`spent_date` is the entry's stored day: the day it started on in its person's zone when it was tracked, which a later change of zone does not move (decision 39); `description` is there only with `descriptions:read`. `overtime` says whether the entry is overtime rather than regular time (TS-095).

### `GET /time_entries/{id}` — `time:read`

One entry, or 404.

### `POST /time_entries` — `time:write`

```json
{
	"project_id": "…",
	"spent_date": "2026-11-03",
	"hours": 1.5,
	"description": "Pairing",
	"task_id": "…",
	"work_package_id": "…"
}
```

`started_at` (ISO 8601 with offset) may replace or go with `spent_date`; without it the entry is placed on the day as the Timesheet's week grid places one. `hours` is above 0 and at most 24, and hours that round to no minutes answer `422`. `user_id`, if sent, must be the maker's. `overtime` (default `false`) records the hours as overtime. `work_package_id` is required while the project has an open work package: none answers `422` `work_package_required`, and a closed one `409` `work_package_closed`. The Timesheet's rules hold: regular time past the day's expected hours, or overtime the organisation does not allow, past its caps or past approved hours, answers `422` `invalid` with what the day has left in its `message`. Answers `201` with the entry and `Location`.

### `PATCH /time_entries/{id}` — `time:write`

Any of `project_id`, `task_id`, `work_package_id` (left out, the entry keeps its own), `started_at`, `ended_at` or `hours` (not both), `description` (null clears it), `overtime`. A change that adds time to an entry on a closed work package, or moves it to one, answers `409` `work_package_closed`. The maker's own entries that have ended. An end after now ("That is ahead of now.") or an entry longer than 24 hours answers `422` `invalid`, and an entry on an invoice `409` `invoiced`. Each refusal's `message` is the Timesheet's sentence.

### `DELETE /time_entries/{id}` — `time:write`

`204`. The maker's own entries that have ended, on a day that is not locked.

### `GET /leave` — `people:read`

Query: `from`, `to`, `user_id`, `per_page`, `cursor`. By `starts_on`, then `id`. `id`, `user`, `kind` (`{ id, name }` or null where the role may not see it), `starts_on`, `ends_on`, `starts_half`, `ends_half`, `status`.

### `GET /work_days` — `time:read`

Query: `from` and `to`, required, at most 62 days; `user_id`, the maker's own when not given, and only a person whose time the maker may see. One row a person and day (TS-097): `user_id`, `date`, `schedule` (`{ id, name }`, the work schedule in force that day), `kind` (`working`, `leave`, `holiday` or `not-a-working-day`; leave without its kind), `half_day`, `start`, `finish` (`HH:MM`, null on a day not worked), `break_minutes`, `scheduled_minutes`, `expected_minutes` (after public holidays and approved leave).

### `GET /expenses` — `expenses:read`

Query: `from`, `to`, `user_id`, `project_id`, `per_page`, `cursor`. `id`, `user`, `project`, `category`, `spent_on`, `amount_minor`, `currency`, `billable`, `reimbursable`, `has_receipt`; `notes` with `descriptions:read`.

### `GET /invoices` — `invoices:read`

For owners, admins and Finance. `id`, `number`, `client`, `status`, `currency`, `issued_on`, `due_on`, `subject`, `subtotal_minor`, `discount_minor`, `tax_minor`, `total_minor`, `sent_at`, `voided_at`.

Every write is in the activity log with the source **via API**.

## Webhooks

An owner or admin adds a webhook on **Integrations › Webhooks**: an `https` address and the events it hears about: time entries, timesheet periods, expenses, invoices, payments. Its signing secret is shown once.

Each change is posted as JSON within a minute:

```
POST https://your.example/hook
Content-Type: application/json
Timesifier-Event: time_entry.created
Timesifier-Delivery: 0193…
Timesifier-Signature: t=1794470400,v1=5f2c…
```

```json
{
	"id": "0193…",
	"event": "time_entry.created",
	"created_at": "2026-11-12T09:00:00.000Z",
	"source": "web",
	"actor": { "id": "…", "name": "Ada Lovelace" },
	"subject": { "type": "time_entry", "id": "…" },
	"changes": { "after": { "projectId": "…", "description": "changed" } },
	"data": { "…": "the entry as GET /time_entries/{id} shows it" }
}
```

Events: `time_entry.started|stopped|created|updated|deleted`, `period.submitted|withdrawn|approved|returned|reopened`, `expense.created|updated|deleted`, `invoice.created|updated|sent|voided|deleted`, `payment.recorded|deleted`, and `ping` for a test. A delivery holds what the webhook's maker would read through the API: nothing about someone they may not see, and a description only if the webhook was added with descriptions. `data` of something since deleted is `{ "id", "deleted": true }`.

**Checking the signature.** Split the header on `,`. Compute HMAC-SHA-256 with the secret of `<t>.<raw body>`, in hex, and compare it in constant time with `v1`. Refuse a `t` more than 5 minutes from now.

```js
const [t, v1] = header.split(",").map((part) => part.split("=")[1]);
const mac = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
const valid =
	crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(v1)) &&
	Math.abs(Date.now() / 1000 - Number(t)) < 300;
```

**Answering.** Any 2xx within 10 seconds is delivered. Anything else, a redirect included, is tried again after 1, 5, 30, 120, 360 and 720 minutes. After the seventh attempt the delivery fails; after three failed deliveries in a row the webhook is switched off and its maker is emailed. Each webhook shows its last answer, its failures in a row and its last ten deliveries. **Give it a new secret** signs every later delivery with the new secret only.

## Calendar feeds

Each person makes a feed on **My account › Calendar feeds**: their approved time off, and if they choose their entries of the last 90 days. A manager can make one of a team they manage: its members' approved time off. The address, `https://timesifier.com/calendar/cal_….ics`, is shown once; anyone with it can read the feed. Revoking it makes it answer 404.

## Import and export

**Integrations › Import time** reads a CSV in Harvest's columns (`Date, Client, Project, Task, Notes, Hours, First name, Last name`, or an `Email`), and Harvest's own export of all time as it is. A row goes to the project whose code is in its `Project code` column, or else whose code or name is in its `Project` column; a project it adds takes the `Project code`. **Import projects** reads `Client`, `Project` and `Project code`. **Export all time** writes the same columns with `Email` and the codes, so it imports again. **Export all invoices as PDFs** downloads one ZIP with every invoice, drafts and void ones included, each the PDF its own page downloads, named by number (`invoice-42.pdf`).
