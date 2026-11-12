# The Timesifier API

Cards TS-081 (the API), TS-087 (webhooks) and TS-089 (calendar feeds). The same API is described for tools in [`openapi.yaml`](openapi.yaml). The code is `app/integrations/api.server.ts`.

## Tokens

An owner or admin makes a token on **Integrations › API tokens › Create token**. It is shown once and starts `tsf_`. Send it with every request:

```
Authorization: Bearer tsf_…
```

A token acts as the person who made it, with their role and teams as they are at each request. It never reaches more than that person could on the pages; the scopes chosen when it was made narrow it further:

| Scope               | Lets the token                                      |
| ------------------- | --------------------------------------------------- |
| `time:read`         | Read time entries, and `GET /me`                    |
| `time:write`        | Add, change and delete the maker's own time entries |
| `descriptions:read` | Read entry descriptions and expense notes           |
| `projects:read`     | Read projects, clients and tasks                    |
| `people:read`       | Read people and their leave                         |
| `expenses:read`     | Read expenses                                       |
| `invoices:read`     | Read invoices                                       |

A token that is revoked, has expired, or whose maker has left the organisation is answered `401`.

## Rate limit

A token may make 100 requests in any 15 seconds. The next is answered `429 Too Many Requests` with `Retry-After`, the seconds to wait.

## Answers

Everything is JSON. A list is `{ "data": [ … ] }`; a list that pages adds `"next_cursor"`, which is passed back as `?cursor=` for the next page, and takes `?per_page=` up to 100. Times are ISO 8601 in UTC; days are `YYYY-MM-DD`; money is in minor units (`total_minor: 12550` is 125.50) with its `currency`.

An error is `{ "error": { "code", "message" } }`, and for `422` also `"fields"`, each field's problem:

| Status | Code                     | When                                                                        |
| ------ | ------------------------ | --------------------------------------------------------------------------- |
| 400    | `bad_json`               | The body is not JSON                                                        |
| 401    | `unauthorized`           | No working token                                                            |
| 403    | `insufficient_scope`     | The token lacks the scope                                                   |
| 403    | `forbidden`              | The maker's role may not do it, or it is someone else's entry               |
| 404    | `not_found`              | Nothing at that address, or nothing the maker may see there                 |
| 405    | `method_not_allowed`     | `Allow` says which methods are                                              |
| 409    | `locked`, `running`      | The day is locked (submitted, approved, lock date), or the entry is running |
| 413    | `too_large`              | A body over 16 KB                                                           |
| 415    | `unsupported_media_type` | A body that is not `application/json`                                       |
| 422    | `invalid`                | Values that cannot be used                                                  |
| 429    | `rate_limited`           | See above                                                                   |

## Who sees what

The pages' rules (`docs/security.md`, "Whose time", "Rates and money"):

| Role                     | Entries and expenses                | People               | Clients | Invoices | Project money | Leave kind     |
| ------------------------ | ----------------------------------- | -------------------- | ------- | -------- | ------------- | -------------- |
| Owner, admin             | Everyone's                          | Everyone, with email | Yes     | Yes      | Yes           | Everyone's     |
| Finance                  | Everyone's                          | Everyone             | Yes     | Yes      | Yes           | Their own      |
| Manager (manages a team) | Their own and their teams' members' | Themselves and teams | No      | No       | No            | Own and teams' |
| Member, contractor       | Their own                           | Themselves           | No      | No       | No            | Their own      |

Everyone sees approved leave of everyone, as the live "not working" status does; requests not yet approved only their own. Every role writes only its own entries.

## Endpoints

All under `https://timesifier.com/api/v1`.

### `GET /me`

The token's maker, organisation, role and scopes.

### `GET /users` — `people:read`

`id`, `name`, `role`, `is_contractor`; `email` for an owner's or admin's token.

### `GET /clients` — `projects:read`

`id`, `name`, `archived`, `currency`. For those shown Clients.

### `GET /projects` — `projects:read`

`id`, `name`, `client` (`{ id, name }` or null), `archived`; for those who see money also `billing_type`, `rate_mode`, `fee_minor`, `currency`, `budget`.

### `GET /tasks` — `projects:read`

`id`, `name`, `archived`, `billable_by_default`, `common`, and `projects`: `[{ id, billable }]`.

### `GET /time_entries` — `time:read`

Query: `from`, `to` (days, at most 366 apart, in the organisation's zone), `user_id`, `project_id`, `per_page`, `cursor`. Newest first.

```json
{
	"id": "0193…",
	"user": { "id": "…", "name": "Ada Lovelace" },
	"project": { "id": "…", "name": "Apollo" },
	"client": { "id": "…", "name": "Initech" },
	"task": { "id": "…", "name": "Design" },
	"spent_date": "2026-11-03",
	"started_at": "2026-11-03T09:00:00.000Z",
	"ended_at": "2026-11-03T10:30:00.000Z",
	"running": false,
	"hours": 1.5,
	"billable": true,
	"description": "Pairing",
	"import_id": null,
	"created_at": "…",
	"updated_at": "…"
}
```

`spent_date` is the day it starts in its person's zone; `description` is there only with `descriptions:read`.

### `GET /time_entries/{id}` — `time:read`

One entry, or 404.

### `POST /time_entries` — `time:write`

```json
{
	"project_id": "…",
	"spent_date": "2026-11-03",
	"hours": 1.5,
	"description": "Pairing",
	"task_id": "…"
}
```

`started_at` (ISO 8601 with offset) may replace or go with `spent_date`; without it the entry is placed on the day as the Timesheet's week grid places one. `hours` is above 0 and at most 24. `user_id`, if sent, must be the maker's. Answers `201` with the entry and `Location`.

### `PATCH /time_entries/{id}` — `time:write`

Any of `project_id`, `task_id`, `started_at`, `ended_at` or `hours` (not both), `description` (null clears it). The maker's own entries that have ended.

### `DELETE /time_entries/{id}` — `time:write`

`204`. The maker's own entries that have ended, on a day that is not locked.

### `GET /leave` — `people:read`

Query: `from`, `to`, `user_id`. `id`, `user`, `kind` (`{ id, name }` or null where the role may not see it), `starts_on`, `ends_on`, `starts_half`, `ends_half`, `status`.

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

**Integrations › Import time** reads a CSV in Harvest's columns (`Date, Client, Project, Task, Notes, Hours, First name, Last name`, or an `Email`), and Harvest's own export of all time as it is. **Export all time** writes the same columns with `Email`, so it imports again.
