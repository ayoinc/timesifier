# Operations

What watches Timesifier in production, and the steps the owner takes to set up what the code cannot (TS-107, decision 61). Alerts go to the platform owner's address: the one listed first in the deployment's `PLATFORM_OWNERS` setting, since the owner named no other.

## What watches what

| Check                      | Where it runs                                                                               | What it checks                                                                                                                                                                                                  | Interval                 | Who hears                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| `/health`                  | The Worker (`app/routes/health.ts`)                                                         | D1 answers `SELECT 1`; R2 answers the head of `health` in `BRAND`. `200 {"status":"ok","database":"ok","files":"ok"}`, or `503` naming the part that failed. One answer per Cloudflare location for 30 seconds. | On request               | Whoever asks                                                    |
| Smoke test                 | GitHub Actions, after each deploy (`scripts/smoke.sh`)                                      | The home page, then `/health` answers `200` with `"status":"ok"`                                                                                                                                                | Every deploy             | The pipeline fails                                              |
| Upptime                    | GitHub Actions in [`ayoinc/timesifier-status`](https://github.com/ayoinc/timesifier-status) | `/health` (`200` and `"status":"ok"`), `/`, `/sign-in`, `/privacy`, `/terms`                                                                                                                                    | 5 minutes                | An issue opens in that repository, and the status page shows it |
| UptimeRobot (107b)         | UptimeRobot Free                                                                            | `/health` for the keyword `"status":"ok"`, and `/` for `200`                                                                                                                                                    | 5 minutes                | Email to the platform owner                                     |
| Cloudflare Monitors (107e) | Cloudflare Observability, on Workers Logs and HTTP requests                                 | Error lines, browser error lines, failed email, and the 5xx rate                                                                                                                                                | 1 minute, over 5 minutes | Email to the platform owner                                     |

The status page is `https://status.timesifier.com`, on GitHub Pages, outside Cloudflare. Until that name resolves and has its certificate, the footer's Status link goes to the repository instead (`OUTSIDE_LINKS.status` in `app/landing/Site.tsx`); change it to `https://status.timesifier.com/` once `curl -sI https://status.timesifier.com/` answers `200`. If that address does not open (for example, when Cloudflare's DNS is down), use the repository itself, `https://github.com/ayoinc/timesifier-status`: its README shows the same table, and each outage is an issue. With a custom domain set, GitHub redirects `ayoinc.github.io/timesifier-status` to that domain, so the `github.io` address is not a fallback.

## Lines the Worker writes for monitors

- `error: <Name> at <route pattern>`: an error on the server (`app/entry.server.tsx`).
- `health: <database|files> failing: <Name>`: a `/health` check that failed.
- `browser-error: <kind> <Name> at <route pattern> in <frame> (release <release>, <time>) on <browser>`: an error in a page (`app/routes/browser-errors.ts`).
- `browser-error: csp <directive> blocked <origin|inline|eval> from <script path|page>:<line> on <browser>`: a Content Security Policy violation.
- `email: send failed`: an email that was not sent.

## Owner: the status page's DNS record (107c)

1. Cloudflare dashboard → `timesifier.com` → **DNS** → **Records** → **Add record**.
2. Type `CNAME`, name `status`, target `ayoinc.github.io`, proxy status **DNS only** (grey cloud), TTL Auto. Save.
3. GitHub → `ayoinc/timesifier-status` → **Settings** → **Pages**. The custom domain `status.timesifier.com` is already set. Wait until the DNS check passes and the certificate is issued (up to an hour), then tick **Enforce HTTPS**.
4. Check: `curl -sI https://status.timesifier.com/` answers `200`.

The repository needs no token. Every workflow runs on its own `GITHUB_TOKEN` with only the permissions it declares. The repository allows only GitHub's actions and `upptime/uptime-monitor` at one pinned commit.

## Owner: UptimeRobot Free (107b)

1. Sign up at https://uptimerobot.com with the platform owner's address, and confirm it. The Free plan allows commercial use, 50 monitors, a 5-minute interval and email alerts.
2. **Alert contact:** the sign-up address is the default email contact. Leave it on, and confirm it under **Integrations & Team** → **Alert contacts**.
3. **Monitor 1:** **New monitor** → type **Keyword**. URL `https://timesifier.com/health`. Keyword `"status":"ok"`. Alert when the keyword **does not exist**, case-sensitive off. Friendly name `Timesifier health`. Interval **5 minutes**. Timeout 30 seconds. Notify the email contact. Create.
4. **Monitor 2:** **New monitor** → type **HTTP(s)**. URL `https://timesifier.com/`. Friendly name `Timesifier home`. Interval **5 minutes**. Under advanced settings, the up status codes are `2xx` only. Notify the email contact. Create.
5. **Drill:** add a third **HTTP(s)** monitor on `https://timesifier.com/health-drill`, which answers 404. Wait for the email, which should arrive within 10 minutes. Write the date on card TS-107, then delete the monitor.

## Owner: Cloudflare Monitors (107e)

The builder could not create these. Wrangler has no command for Monitors, and the deploy's OAuth token has no Notifications scope: a read of `/accounts/<id>/alerting/v3/policies` answered `10000 Authentication error` on 2026-11-23. Monitors are created in the dashboard ([Monitors](https://developers.cloudflare.com/notifications/monitors/)).

For each monitor: Cloudflare dashboard → **Observability** → **Alerts** → **Monitors** → **Create a Monitor** → **Threshold**. Set the execution interval to **1 minute**, the evaluation window to **5 minutes**, and the repeat notification interval to **1h**. The destination is an email to the platform owner's address. Use the visual builder with dataset scope **Account** and dataset **Workers Logs** (`logs.workersLogs`), metric `COUNT`, and a filter on the Worker `timesifier`. Pick the log message's field from the builder's field list: field names depend on the dataset, so read them there rather than guessing.

1. **`Timesifier errors`**: filter message _starts with_ `error:`. Comparison `>` `10`.
2. **`Timesifier browser errors`**: filter message _starts with_ `browser-error:`. Comparison `>` `10`.
3. **`Timesifier email failed`**: filter message _starts with_ `email: send failed`. Comparison `>` `0`.
4. **`Timesifier 5xx`**: detection **SLO** instead of Threshold. Dataset scope **Zone** `timesifier.com`, dataset HTTP requests (`events.httpRequests`). The bad events query counts `edgeResponseStatus >= 500`, the total events query counts every request, and both filter on host `timesifier.com`. SLO target **95%**, short window **5 minutes**, long window **1 hour**, minimum event count `20`.
5. **Drill:** send 20 beacons from a terminal and wait for the email from monitor 2:

   ```sh
   for i in $(seq 1 20); do curl -s -o /dev/null -X POST https://timesifier.com/browser-errors \
     -H 'Content-Type: text/plain' \
     --data '{"kind":"error","name":"DrillError","route":"/","frame":null,"release":"drill","time":"2026-11-23T00:00:00.000Z"}'; done
   ```

   The endpoint logs at most 20 a minute from one address, so all 20 are logged. Write the date on card TS-107.
