# OCX QM

A local quota manager for OCX: the remaining quota of every OpenCodex provider and account, what each of them has used, and the API-equivalent unit price behind those numbers, in one place. Provider access is read-only: it never switches accounts, changes subscriptions at a provider, or calls inference. The dashboard stores your account-to-plan choices in its own local database. Uses macOS system typography, grouped rows, and the device's light/dark preference. The native macOS menu-bar client in `macos/` consumes the same JSON API.

## Name and terminology

The product is **OCX QM**, expanded as **Quota Manager for OCX** / **쿼타 매니저 for OCX**. The earlier name, Quota Monitor, survives only in history notes and
in the compatibility identifiers listed below.

*Manager* describes what you can inspect and organize here: remaining quota, usage, and model prices.
It does not switch accounts, change a plan, or buy capacity.

| Term | Meaning |
|---|---|
| 남은 한도 | Remaining quota of a provider window, as the provider reports it |
| 사용현황 | Recorded usage over a rolling period: calls, tokens, and API-equivalent amount |
| API 환산액 | Recorded tokens priced at API rates. A reference cost, not a charge |
| 모델 가격 | Per-model unit price with its source, unit, conditions and check date |

The macOS menu-bar project shares this name and these terms. Native screens belong to that project.

### Compatibility identifiers

The display name is separate from the identifiers that installed services and stored data depend on.
These keep their original spelling, so a global search and replace of the old name would break them:

- `package.json` name `quota-monitor`
- `deploy/quota-monitor.service` and its unit name; checkout paths are configured per installation
- `QUOTA_DATA_DIR` and its default `~/.local/state/quota-monitor`
- the browser key `quota-monitor.provider-order.v1`
- the log prefixes in `src/server.mjs` and `src/collector.mjs`
- the source-identity salt `quota-monitor-ollama` in `src/ollama.mjs`
- `macos/Info.plist` `CFBundleIdentifier` `local.quota-monitor.menubar` and `CFBundleName`
  `Quota Monitor`, and the bundle paths in `macos/build.sh`


## Run

### Mac menu-bar client

On a Mac with Xcode Command Line Tools, run `bash macos/build.sh`. This runs the Swift model tests and creates `macos/build/Quota Monitor.app` for that Mac's CPU. Open the app to use it, or copy it to Applications. Requires macOS 13 or newer. The locally built app is ad-hoc signed, not notarized for public distribution.

The 400-point popover has a summary and a three-column provider selector with account quota bars. The native NSPopover has explicit content-driven sizing: a reserved loading viewport, measured chrome and body, and a screen-height cap. Provider navigation scrolls independently after 120 points. A pin beside a summary limit selects the provider percentage shown in the menu bar; different quota periods and providers are never merged into an invented global percentage. The app refreshes every 30 seconds. Failed refreshes retain the previous snapshot with a connection warning; locally expired observations become unavailable. Settings accepts an HTTPS server origin and persists it on the Mac. A new installation starts with an empty server address. Enter your own HTTPS origin in Settings; an existing saved address remains in use. For a Tailscale origin, the Mac needs access to that tailnet. The app reads only `/api/v1/snapshot`, requires no provider credentials, and has no account-switching, inference, cost-analysis, or background server functionality.

`macos/Sources/QuotaModel.swift` shares `public/app.js`'s matching-window average rule and its hidden Codex Spark windows across the JSON boundary. It also checks observation age/reset time locally so offline data cannot stay current indefinitely. Nullable `stale` values are accepted with those timestamp checks. Tests live in `macos/Tests/`.

### Web server

Requires Node.js 24+. No third-party runtime dependencies or install step.

```sh
git clone https://github.com/thisisjun786/ocx-qm.git
cd ocx-qm
npm start
# http://127.0.0.1:8787
```

For optional settings, copy [.env.example](.env.example) to `.env` and run `node --env-file=.env src/server.mjs`; `npm start` does not load `.env` automatically. No personal server or subscription is preselected.

Set `QUOTA_HOST` to your Tailscale IPv4 and `QUOTA_PORT` to an unused port for private remote access. `OPENCODEX_HOME` defaults to `~/.opencodex`; `QUOTA_CODEX_HOME` defaults to `CODEX_HOME`, then `~/.codex`. Do not expose the service publicly: it trusts tailnet network access and masks account emails, with no application login. Host/Origin guards are browser defenses, not user authentication.

## Data contract

`GET /api/v1/snapshot` returns `schemaVersion: 1`, ISO `observedAt`, `source`, `refreshIntervalSeconds`, `warnings`, and `providers`. Each provider has identity, enabled state, default model, and account rows. Account rows contain masked label, optional plan, selected-account flag, status, measurement timestamp, quota mode, and windows with used/remaining percentages and reset timestamps. `active` means configured selection, not current request traffic. There is no single percentage combining different providers or quota periods. Summary percentages are equal-account averages, not plan-capacity-weighted pools.

The backend reads OpenCodex snapshots without importing its SDK. When `QUOTA_OPENCODEX_ORIGIN` is configured, the collector also makes authenticated, loopback-only `GET` requests to OpenCodex quota endpoints every 10 seconds; it never calls inference, login, or account-selection endpoints. It persists normalized measurements so quota observations, including API-key quota responses, survive a monitor restart. Each account's last observation remains visible. Readings older than 15 minutes, invalid/future timestamps, or past reset times are stale. Missing, expired, or reauthentication-required quotas remain unavailable. All original OpenCodex files remain read-only.

The main Codex account uses only identity-bound `mainPolicyQuota` after matching the installed OpenCodex SHA-256 identity scheme to native auth. Configured extra accounts use their own opaque store IDs. Tokens and key hints are never returned. Config and credential files are never served as static assets. Errors use generic messages.

### Usage periods

`analytics.periods` reports five trailing spans on every provider and account: `oneHour`, `fiveHour`, `twentyFourHour`, `weekly` and `monthly` — 1, 5, 24, 168 and 720 hours. All five end at the same instant, the last usage-log read that finished successfully, and each period carries its own `startedAt`, `endedAt` and `hours`. The boundary is half-open: a call exactly at `startedAt` is outside the period and a call exactly at `endedAt` is inside it. These are instants, never calendar-aligned, so `twentyFourHour` is the last 24 hours rather than today's date, and it does not restart at local midnight. `endedAt` always equals `pace.observedAt`; it equals the snapshot's `usageObservedAt` only when a read timestamp exists and is not ahead of the clock, since the boundary falls back to the caller's clock when no read has been recorded and never moves past it.

A period is a span of time, not a claim of observation. Two different fields describe what stands behind it, and they answer different questions.

`logCoverageHours` is how much of the span the retained usage log reaches back over. It is a property of the rows we kept: OpenCodex writes one log for every provider, so a single old row gives a full span to an account added this morning. It never means that account was watched, and it is never evidence that a period had no calls.

`observedCoverageHours` is how much of the span we were actually reading the log, taken from the run of reads that completed without a detected break. The run starts when reading began or restarted, and its far end only moves when a read reached the end of the file, so a record left half-written holds it back. A break is recorded when the file is not the one we were reading, when the bytes we already consumed or a record we saw left unresolved no longer match, when a record could not be decoded, or when a history reset or the retention boundary deliberately excluded rows. `usageObservedSince` and `usageObservedThrough` report that interval on the snapshot.

This is a detection claim, not a proof. A full `observedCoverageHours` means no break was detected across the span; it does not prove no call existed. A log rewritten so that its first bytes, its length past our cursor, its inode and its birth time all still match can hide a call, and we would not see it. The checks also run between reads, so a change made and undone in between goes unnoticed. Read the field as an operational observation, not a guarantee.

Breaks are recorded in the safe direction, so some spans read as unobserved although nothing was lost: a harmless malformed line, a rotation that dropped no call you care about, a break recorded just before a read failed, and the retention boundary advancing on a read that skipped nothing. `usageExcludedBefore` is a conservative completeness boundary, not evidence that rows were deleted. If every read leaves an unresolved record, the far end never advances and coverage stays at zero until one clean read completes.

Read these together with the amount, pricing and collection-status fields to tell four situations apart:

| Situation | How it reads |
| --- | --- |
| Not observed for the whole span | `observedCoverageHours` below `hours`; whatever the log happens to retain does not change this |
| Observed with no calls | `observedCoverageHours` equal to `hours` with `requests: 0` |
| Prices unconfirmed | `unknownPriceRequests` above 0; `apiUsd` is null when no call in the span had a confirmed price |
| Collection stopped | `endedAt` behind the snapshot's `observedAt`, with `usageStale` and `analytics.status` |

Because the span is anchored to the last successful read, an outage does not read as idle time: the numbers freeze instead of diluting. Retention interacts with the longer periods — after an outage longer than the gap between retention and a period, the start of that period falls outside what was kept, and both coverage figures shrink with it rather than overstating the sample. The one-hour figure also runs slightly low for a different reason: a call is recorded when it finishes but timestamped when it started, so work still in flight at the last read is not counted yet.

A provider period splits into three parts, each queried on its own rather than derived from the others: `listedAccount`* for the accounts the snapshot lists, `unattributed`* for calls no account claims, and `unlistedAccount`* for calls belonging to an account id the snapshot does not list, which is where a removed account's history lives. The three add up to the provider total for calls, tokens and amount, so every retained call is explained. Attribution is never rewritten and no total is reduced; a removed account keeps its rows and its identity, they simply move into the unlisted part. Adding up the account rows instead can disagree when a snapshot repeats an account id, which is why the listed subtotal is published separately. Amounts are sums of floating-point values, so the three parts match the total within 1e-9 relative rather than bit for bit; call counts are exact, and token counts are exact while the total stays a whole number below 2^53. A part is `null` rather than zero when it holds no priced call. `analytics.unattributed` remains the existing 7-day subtotal and matches `periods.weekly`.

The exhaustion forecast and the suggested account count keep their own 7-day sample and are not re-based on whichever period is being viewed; `pace.basisPeriod` names that sample.

## Development

```sh
npm run check
npm test
```

`src/snapshot.mjs` owns source-file translation, `src/server.mjs` owns HTTP, `public/` owns presentation. Tests use isolated synthetic files and ephemeral loopback ports. No tests call paid providers. Use isolated test data and compare the rendered dashboard at desktop, tablet and mobile widths.

## Service

The example [systemd unit](deploy/quota-monitor.service) runs on loopback. Set its `WorkingDirectory` to your checkout and `ExecStart` to your Node.js 24+ executable (`command -v node`). Optional settings live in `~/.config/ocx-qm/environment`; use absolute paths.

Install the edited unit as `~/.config/systemd/user/quota-monitor.service`, then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now quota-monitor.service
```

Before upgrading, retain the previous source and unit and back up `QUOTA_DATA_DIR`. Restart with `systemctl --user restart quota-monitor.service`. To roll back, restore that source and unit, reload systemd and restart; keep the history and subscription databases. Stopping this unit does not stop OpenCodex. Publishing this repository does not authorize or perform a service deployment.

## Usage efficiency and quota forecasts

The server samples quota and usage every 10 seconds even with no browser open. `QUOTA_DATA_DIR` (default `~/.local/state/quota-monitor`, respecting `XDG_STATE_HOME`) contains a private SQLite history database. OpenCodex files are still read-only. The collector saves only allowlisted quota observations and normalized usage totals; no credentials, emails, prompts, conversation IDs or credential contents are saved in the history database. Existing source `usage.jsonl` is imported incrementally; offsets commit with imported records, partial trailing lines wait for completion, and request/attempt IDs are hashed for deduplication. The database persists through service restarts. Treat it as personal usage data and back up this directory to retain history. Changing the data directory starts a separate history. A deliberate clean reset creates an empty database with a persisted `historyResetAt` timestamp and a usage-log cursor at the last complete pre-reset line. The collector excludes quota samples and usage entries older than that timestamp, including later log replays and rotation. That cursor carries no observation history, so observed coverage restarts at the first read after the reset, and the reset timestamp also bounds the observed span. Existing raw logs and account settings stay intact; archive the previous database before switching. Capacity and forecasts rebuild from the new observations.

Storage defaults: `QUOTA_RETENTION_DAYS=90` and `QUOTA_DB_MAX_MIB=512`. On collection, once per day, records strictly older than the retention cutoff are removed from quota samples, usage, usage timings, and Ollama observations in one transaction. Cursor and pricing metadata remain intact. Imports skip expired rows even during replay, so source logs cannot repopulate removed history. The source OpenCodex logs are never modified. Retention must be at least 31 days to preserve the 30-day calculations. Back up before deploying a shorter retention policy.

The size limit applies to SQLite's main database pages, including indexes and free pages. Full storage fails new writes and the collector reports a collection error; it never evicts recent records to make room. Freed pages are reused; cleanup does not immediately shrink the file. WAL uses automatic checkpoints and a 16MiB post-checkpoint size target, not a hard total-directory cap: transactions or blocked checkpoints can temporarily exceed it. Leave disk headroom for WAL and backups. An existing database larger than the configured main-file limit is rejected without truncation. Increasing the limit or archiving data requires an explicit operational action.

`GET /api/v1/snapshot` retains schema version 1 and all existing fields. Additive `analytics` fields appear on the snapshot, providers, accounts and quota windows. The subscription selection endpoint below writes only monitor-owned preferences.

- **Actual API equivalent:** rolling 1 hour, 5 hours, 24 hours, 7 days and 30 days, all ending at the same successful usage-log read. Boundaries and sample coverage are defined under [Usage periods](#usage-periods). Each physical upstream attempt is counted once, including billed retries; parent totals are not added again. Amounts with unknown prices are partial subtotals, never zero-priced usage. Price basis and coverage are shown; a local catalog is an estimate, not verified official billing.
- **Average pace:** recorded API equivalent over the past 7 days (or available shorter log span), including idle hours. It keeps that 7-day sample whichever period is being viewed, and `pace.basisPeriod` names it. Normalizing this rate to 5 hours or 7 days is a usage forecast, not a provider quota limit. Providers without a 5-hour limit still have a time-normalized usage estimate, not an invented 5-hour quota.
- **Subscription value:** rolling 30-day API equivalent divided by the current official monthly list price of the plan explicitly selected for that account. Taxes, promotions, annual billing and actual payment dates are not inferred. Quota resets are not subscription renewal dates. Plan information comes from configured metadata or identity-bound local login/profile claims.
- **Quota velocity:** percentage-point change per elapsed hour, recent 1-hour view and average of observed intervals in the same reset window. Requires at least 5 minutes of new provider observations. Re-reading one cache timestamp is not a new observation. Only the latest contiguous run is used: gaps longer than 20 minutes, non-increasing timestamps, large downward adjustments, and intervening resets start a new run. Within a fixed-reset run, readings up to 1 percentage point below its high-water value are held at that value for calculation, so a dip and rebound cannot count the same consumption twice. A larger fall starts a new run; repeated small falls are compared with the high-water value, not the immediately preceding reading. The recent hour is anchored to the latest observation, with partial boundary intervals counted proportionally. Reset timestamp rounding within 60 seconds of the segment anchor is tolerated; a current run must also match the current reset within 60 seconds. Every rate and capacity calculation uses the same segment boundaries. Stale, paused and reauthentication-needed accounts do not receive a current exhaustion prediction.
- **Exhaustion ETA:** project remaining quota from the latest observation timestamp, using total consumed percentage points divided by observed hours over the latest 7 days, or all available history if shorter. Observed idle time and valid intervals from previous reset cycles are included. Gaps over 20 minutes, downward adjustments beyond the 1pp envelope, and intervals crossing a reset contribute neither time nor consumption. Held small dips contribute observed time without new consumption. Missing observations are not assumed to be idle. Each account and quota window stays separate. A positive forecast requires 15 observed minutes and 2 percentage points of change; this is only a minimum, not evidence of a mature long-term estimate. Under 24 hours is explicitly labeled an initial estimate. `forecastObservedHours` reports the actual denominator and `forecastRatePpHour` is this long-term mean; `recentRatePpHour` remains the recent hourly average of the same reconciled observations for diagnostics. `forecastObservedAt` identifies the measurement basis. Re-reading a cached sample cannot move the ETA. Compare it with the actual reset timestamp; expired resets suppress forecasts. Zero observed change produces no finite ETA, and an already full quota is exhausted before reset.
- **100% quota value:** matched API equivalent divided by the consumed percentage points of every contiguous interval whose usage log has been read, scaled to 100%. Every window calibrates over the last 30 days, not only its own period: the dollar value of a limit is a property of the plan, so more observed cycles beat a shorter, fresher sample. The quota history chart spans the window own period instead: five hours for a five-hour limit, seven days for a weekly one, thirty days for a monthly one, and seven days for a window whose length is not known. While a reading is unchanged the collector keeps one sample every four minutes instead of one per collection, which stays well inside the 20-minute gap threshold so idle time is still observed. A window without a reset timestamp, such as the Ollama Cloud limits, cannot be confirmed to belong to one quota cycle and therefore receives no dollar conversion at all. A run is never excluded because its own dollars came out zero: that made the estimate depend on whether a stray cheap request happened to land inside a window consumed elsewhere. Runs with no priced usage contribute their consumption to the denominator and nothing to the numerator, are reported as `unexplainedDeltaPp`, and set `capacityBasis` to `lower-bound`, shown as `보수 추정`. Publishing a value still requires at least one run with attributed, priced usage; when none exists the value stays unknown rather than zero. Quota movement past the last log read stays out of both sides. Changes below 2 percentage points are retained as low-confidence estimates, with the rounding and refresh-delay limitation shown. Missing attribution or unpriced calls produce a partial estimate. `capacityMatchedQuotaCoverage` reports the share of observed quota growth linked to priced usage, and `capacityObservedAt` identifies the last matched run. These estimates are not guaranteed lower bounds: unrecorded usage pulls the value down, while integer-percent reporting can round a consumed interval down and push the value up. Custom model-specific/credit windows do not receive an all-model dollar conversion. Per-window values overlap and must not be added together. Untracked use outside OpenCodex can bias this estimate.

The 1pp envelope is a calculation assumption, not proof that a provider refunded nothing. It can absorb a real small downward adjustment or a trailing dip; capacity confidence is lowered when it applies. `quotaAdjustment` reports the tolerance and adjusted sample count. Stored observations, chart values and the current remaining percentage stay raw; freshness is checked against the raw latest observation. Missing resets remain unsupported, and reset timestamps are anchored rather than chained across a moving window.

Account attribution follows installed OpenCodex's durable `main`, `p<hex6>` and `o<hex6>` labels, including `main` and `p<hex6>` provider suffixes. OAuth `o<hex6>` attribution uses the explicit `accountLogLabel` field. Ambiguous, removed or unlabeled accounts stay in provider totals and an unattributed subtotal; they are never assigned to today's selected account. Historical identity changes behind the `main` label cannot be reconstructed from usage logs alone.

Implementation: `src/history.mjs` owns storage and ingestion, `src/identity.mjs` owns account label/plan matching, `src/analytics.mjs` owns estimates, `src/pricing.mjs` owns price provenance, and `src/collector.mjs` owns the timer and lifecycle.

### Subscription count suggestions

Provider suggestions compare the recent 7-day pace with the 30-day baseline and use the larger weekly demand. Each observation span starts at the first positive priced request inside that window and runs through the last successful usage read, including subsequent observed idle time; ancient or unpriced records do not pad its denominator. At least one day of priced history is required. This measures the observed activity span, which can be shorter than a full calendar week or month. The count uses the arithmetic mean of fresh, measured weekly capacities, even when only part of the available accounts have a measurable capacity. One measured account is sufficient. Five-hour peak demand uses the mean of measured five-hour capacities independently; otherwise the weekly estimate stays provisional.

The recommended count leaves 20% capacity spare. Unpriced calls are skipped and partial usage or capacity keeps the result provisional; partial capacities remain included as estimates. Subscription prices affect only the budget estimate: calculate it from the measured cohort's average price when all those prices are known, otherwise leave the budget unavailable. Paused and reauth accounts are excluded. A temporary quota-fetch failure does not remove a configured subscription from `currentAccounts`; only fresh windows enter the capacity sample. Mixed-plan samples remain provisional and assume a similar account mix. These are workload estimates, not purchase actions or guarantees.

### Account subscription settings

Open a provider or **전체 계정** in the web dashboard. Each account has a **구독 요금제** dropdown and **저장** button. Choose the service plan you use; choosing **미선택** clears the current selection and excludes that account's subscription price from calculations. This records your choice in OCX QM; it does not buy, cancel, or change a provider subscription. There is no custom amount field, provider-wide price override, or automatic selection from a detected `pro` label.

The reviewed [subscription catalog](src/subscription-catalog.json) contains individual web plans in USD per month, with official source URLs and check dates. Current coverage: ChatGPT, Claude, Cursor, Ollama Cloud, Grok and OpenCode Go. Annual discounts, regional/app-store prices, tax, shared team plans and actual invoices are not modeled. Name-only plans without a verified monthly price remain selectable but unpriced. Official pages can change; collection is a reviewed data update, not automatic website scraping.

At startup, the server validates and transactionally imports the catalog into `QUOTA_DATA_DIR/subscriptions.sqlite`. This separate file holds plans and account selections; history retention or a history-only reset does not remove them. Back it up with the rest of the private data directory. Raw tokens and credential identity are not stored in the selection table or exposed by the API. A private fingerprint binds a selection to its account; a replaced login or key cannot inherit a slot's old choice. When only an opaque credential is available, refreshing it can require reselection. A missing identity prevents saving. Old bindings remain local and are not listed to the new account.

Prices older than 30 days, retired plans, unverified prices and unselected accounts have `monthlyUsd: null`. The last quoted amount can be displayed with a warning but is excluded from current totals and ratios. A provider or overview total is unavailable if any included account lacks a current price; it is never a partial sum presented as a complete total.

To update prices, re-open each official source, edit the JSON facts and `checkedAt` only for facts actually rechecked, and advance its root `revision` timestamp. Validate before importing:

```sh
npm run import:subscriptions -- --validate
npm run import:subscriptions
```

Use the same `QUOTA_DATA_DIR` as the server. `QUOTA_SUBSCRIPTION_CATALOG` selects a reviewed replacement file. An older revision cannot overwrite a newer DB; an equal revision with different content is rejected. Invalid or missing files retain prior rows and report diagnostics. A live server sees a CLI import on a subsequent refresh. An import never selects a plan for an account.

| Route | Behavior |
|---|---|
| `GET /api/v1/subscriptions` | `{plans, selections, diagnostics}`; only selections bound to current accounts |
| `PUT /api/v1/subscriptions/selection` | JSON `{provider, account, planId, selectionContext}`; `planId: null` clears the current choice; returns the resolved subscription |

Copy the opaque `selectionContext` from that account’s snapshot subscription into PUT. It prevents an old screen from applying a choice to a replaced login; stale contexts return 409 and require a refresh. It changes on server restart and contains no credential or reusable identity. PUT requires an exact allowed `Origin`, JSON content type, a body no larger than 4 KiB and a currently listed account with a valid binding. Unknown accounts return 404; mismatched/retired plans or unknown identity return 422. Invalid input returns 400, forbidden origin 403, oversized bodies 413 and unsupported media 415. No CORS access is enabled. Network access remains the trust boundary: another trusted tailnet client can change these preferences.

Snapshot schema stays at version 1. `account.analytics.subscription` retains `label` and nullable `monthlyUsd`, with additive `planId`, `basis`, `sourceUrl`, `checkedAt` and last-quote details. `basis` distinguishes `official-list`, `unselected`, `unbound`, `unverified`, `stale` and `retired`. Subscription prices affect comparison amounts, never quota capacity or usage attribution.

### Ollama credit comparison

`npm run compare:ollama -- --days 30 --json /absolute/output.json --html /absolute/output.html` reads the existing OpenCodex `usage.jsonl` without modifying it or the monitor database. `--log PATH`, `--from ISO`, `--to ISO`, and `--cache-rate 0.8` allow an explicit source, interval, and cache assumption. The generated HTML is self-contained and lets the reader change the cache rate locally. Output contains model/provider aggregates, never account labels, request IDs, prompts, or credentials. Keep these personal reports outside the repository.

The default cache assumption is the sum of reported cache-read tokens divided by reported input tokens from other providers in the same interval. Only records with valid explicit cache fields enter this denominator; estimated tokens, absent cache, and Ollama itself are excluded. Ollama records with actual cache values keep them, including a measured zero. Only missing cache fields use the assumption. Missing reference data leaves the estimate unavailable until a manual rate is supplied. Models without a published cache price retain full input price and are counted separately.

Model prices are hardcoded from [Ollama's pricing table](https://ollama.com/pricing), checked 2026-09-10. DeepSeek prices double Monday through Friday, 12:00–18:00 UTC, using each request's timestamp. New Pro costs $20/month with $60 credits, Max $100 with $300, and Team $500 with $1,000. The comparison prices recorded work under those current rates; it is not the old GPU quota, an actual bill, a measured monthly credit balance, or a forecast. Partial token/model coverage remains visible. The raw-log comparison can include records older than a dashboard history reset; it does not restore them into dashboard history.

### Cursor cache assumption and 10-second refresh (2026-09-10)

Cursor API-equivalent amounts now use the same measured, token-weighted cache share as the Ollama comparison. The collector calls `compareOllamaUsage` on the retained raw log over the latest 30 days every five minutes. Cursor and Ollama are excluded from the reference; only valid, explicitly reported cache and input tokens from other providers count. This may include pre-reset raw observations for the reference average, but never restores pre-reset usage into dashboard totals. A report generated at another time or with a manual slider value is a separate scenario; matching log and interval produce the same default rate.

Only Cursor calls with absent cache-read fields and supported token/cache prices receive an assumption. Explicit cache values (including zero), malformed cache fields, reported cache writes, unknown models and unsupported price/tier cases are not replaced. Missing reference data leaves the undiscounted estimate; a failed reference read keeps the last successful rate and is marked stale. Cursor input/output tokens also remain estimates.

`cursor_cache_costs` preserves each eligible call's no-cache/full-cache prices and eligible input token count. The original `usage` amount, token fields and attribution remain intact. Existing history gets these coefficients during the normal pricing revision replay. `usage_valued` is a temporary read view applying the current average, so amounts, pace, quota value and recommendations all use the same rate; a new average updates existing eligible history without rescanning or rewriting those rows. Original zero-cache and other-provider amounts stay unchanged. Coefficients expire with the corresponding retained usage. `cacheEstimatedRequests`, `estimatedCachedTokens`, and `noCacheApiUsd` disclose the scenario separately from measured cache. The UI shows the applied percentage, before/after amounts, and an estimate marker.

The web timer, snapshot refresh hint, and server collection interval are 10 seconds. Collection is single-flight, and provider failure backoff remains in place; slow responses may delay a completed observation. Cache-reference scans remain five minutes apart. The separately installed native Mac application still uses its existing timer.

### Claude cache-write retention

`QUOTA_CLAUDE_CACHE_TTL=1h` and `QUOTA_CLAUDE_CACHE_FROM=<ISO instant>` select the one-hour cache-write reference price for `anthropic` calls at or after that instant. The start is inclusive; older calls, `anthropic-apikey`, Cursor-routed Claude and other providers retain their existing valuation. One-hour writes cost 2× base input, compared with 1.25× for five-minute writes ([Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), checked 2026-09-15). Input, output and cache-read token amounts and rates stay unchanged.

The setting is a user assumption because OCX's normalized log does not retain cache TTL. `anthropic.analytics.cacheWriteAssumption` exposes its TTL, start and basis; current model price quotes use the same setting after the start. Missing settings retain the five-minute default. Invalid TTL values and a one-hour setting without a valid start fail startup rather than silently choosing a different valuation. Set `5m` or remove the settings and restart to restore the original amounts.

`claude_cache_costs` stores each eligible call's five-minute and one-hour reference amounts plus cache-write token count. The normal pricing revision replay backfills these coefficients from retained raw logs, matching the existing row's identity, tokens and base amount. `usage_valued` applies the setting when reading statistics; it never overwrites the original `usage.usd`, tokens or attribution. Replaying or restarting does not duplicate calls. A row whose raw record is unavailable or does not match retains its original amount; a configured setting alone does not prove every retained call was revalued. Wait for pricing replay completion and verify matched row coverage before comparing amounts. Sidecar rows expire with their usage rows, and history-reset exclusions still apply. The previous release can read the same database and ignores the added table.

### Price evidence (2026-09-09, Ollama rechecked 2026-09-10)

Public subscription sources: [ChatGPT Pro tiers](https://help.openai.com/en/articles/9793128-what-is-chatgpt-pro), [Claude Max tiers](https://support.claude.com/en/articles/11049741-what-is-the-max-plan), [Cursor](https://cursor.com/pricing), [Ollama](https://ollama.com/pricing), [Grok](https://x.ai/pricing). These links are price evidence, not an account-plan detector. Only an explicit per-account choice selects a subscription price.

API reference sources: [OpenAI](https://developers.openai.com/api/docs/pricing), [Claude](https://platform.claude.com/docs/en/about-claude/pricing), [xAI](https://docs.x.ai/developers/pricing). For the current GPT-6/GPT-5.6 reference rows, OpenAI prompt sizes above 272k use their long-context price; xAI at or above 200k uses its long-context price. Known confirmed service tiers are included; unsupported tier combinations remain unpriced. Cached input is included in input, reasoning is included in output, and neither is added twice. Claude cache writes default to the 5-minute price as an explicit estimate because normalized usage does not retain cache TTL. The time-bounded [Claude cache setting](#claude-cache-write-retention) can apply the 1-hour price to attributed `anthropic` usage. Gemini 3.8 Flash uses the exact installed OpenCodex 2.48.0 expected-price tuple as a **local catalog estimate**; the current official row was not located. GPT-5.4 mini uses its verified base input/cache/output rates; its unsupported long-context, Fast-tier and cache-write cases remain unpriced. Composer 2.5 Fast uses the official Cursor token rates and does not assume a cache-write price. Rates are reference valuations, not reconstructed historical invoices.

### New model prices and DeepSeek V4.1 Flash (2026-09-10)

`src/opencode-pricing.mjs` uses the [Go-specific official price table](https://opencode.ai/docs/go/), including Qwen/Grok/Luna context thresholds. Zen and Ollama have different tariffs and are not aliases for Go. Go DeepSeek peak hours are weekdays 01:00–04:00 and 06:00–10:00 UTC; Ollama retains its own 12:00–18:00 UTC schedule.

The [DeepSeek release announcement](https://api-docs.deepseek.com/news/news260910) sets the new Flash tariff's start to 2026-09-10 04:00 UTC. `deepseek-flash`, `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp` use $0.15 input, $0.003 cached input, and $0.60 output per million tokens off-peak; peak doubles all three. Earlier unpriced calls stay unknown because their historical tariff is not verified here. The direct DeepSeek API redirects V4 Pro to Flash from 2026-09-14 04:00 UTC. Go's post-transition Pro tariff is not yet confirmed, so those future calls stay unpriced until Go confirms it. No automatic Flash substitution is applied to Ollama. Go's monthly model limits differ, even across the Flash aliases; this module values tokens and does not merge or infer those quota capacities.

The collector also reads the installed OpenCode/models.dev cache at `$XDG_CACHE_HOME/opencode/models.json` (default `~/.cache/opencode/models.json`), or `QUOTA_MODEL_CATALOG`. Only an exact provider plus model match can supply a missing base price. Such values are always `local-catalog` estimates, never upgraded to official evidence. Official prices and explicit unsupported tariff conditions take precedence. Unknown cache prices, invalid/all-zero rates, unrecognized price tiers and unsupported service tiers remain unpriced. This read-only integration adds no network download; new models become available when OpenCode refreshes its local cache. Missing or invalid cache files do not interrupt usage collection; last valid rows are retained as stale, with status and timestamp in `analytics.pricingCatalog`.

### Model price evidence

`lookupModelPrice(provider, model, conditions)` returns one model's unit price together with the evidence behind it: `rates` in `usd-per-million-tokens` (input, output, cache read, cache write), `sourceUrl`, `checkedAt`, `effectiveFrom`/`effectiveTo`, the `conditions` that change the rate, and a `status`. A provider and an exact model ID are both required — a model ID alone never selects a price, because the same ID is published by many providers at different prices. It resolves through the same selection order the usage valuation uses, so a quoted unit price cannot drift from the amount recorded.

`status` ranks the evidence: `official` (the provider's own published page), `ocx-provided` (a price the installed OpenCodex publishes with its own source and check date, currently `gpt-daybreak-blue-latest` and `gemini-3.8-flash` from 2.55.0), `local-catalog` (a models.dev/OpenCode cache row), and `unpriced`. When a lower-ranked source states a different number for the same conditions, the higher rank is used and the disagreement is reported in `conflict` rather than merged away. Both sides are compared after their own conditions are applied, so a catalog row without a long-context tier conflicts with a built-in rate that has one, and a catalog row carrying the same tier does not. The catalog expresses context thresholds and nothing else, so under an applied service tier or an active peak multiplier it states nothing comparable and no conflict is claimed. This is separate from the `basis` stored on each usage row, which remains the two-value estimate flag that existing capacity confidence and monthly value ratios read.

A missing rate stays `null` and a published free rate stays `0`; conditional multipliers never turn the first into the second. `unsupported` names a field whose tuple holds a number the valuation still refuses, such as Ollama cache writes. Effective windows are enforced, not decorative: Go's V4 Pro transition and the Gemini 3.8 Flash promotional rate both stop at their published endpoint (2027-01-01T00:00:00Z for the latter) and stay unpriced afterwards rather than assuming the successor tariff.

`provider.analytics.modelPrices` lists models from two separate discovery sources, marked per row in `sources`: `ocx-config` (OCX's `providers.<id>.models` and `defaultModel`, minus provider-qualified `disabledModels`) and `observed` (models actually recorded in the usage log across retained history, uncapped). The models.dev cache supplies prices to these rows but never creates them, so a catalog of several thousand foreign models never enters the response. A model with no public price keeps its place with null rates and a reason. Model ids are validated by shape rather than by an allowlist, so real OCX context variants such as `k3[1m]`, `glm-5.3[1m]` and `claude-opus-4-8[1m]` stay listed, as does the catalog's leading-tilde alias `~anthropic/claude-opus-latest`; across the installed 2.55.0 package and the models.dev cache every model id passes. Configuration and home paths do not: a segment beginning with a dot is a hidden file rather than a model name, a tilde is an alias marker only as a single leading character of a two-segment id, and traversals, drive letters, whitespace and control characters are refused as before. A dot-free relative path such as `example/config.json` is still accepted as a model name, because separating one from a vendor namespace is not something the shape can decide. Condition labels are sent once as `analytics.modelPriceConditions`.

Two limits are deliberate. These are the attributed provider's **current** prices, not a reconstruction of the tariff that priced a past call: usage attribution folds `chatgpt` and `openai-multi` into `openai`, so `providerBasis` is `attributed` and a stored key may quote a price the original key did not have. And the list covers providers present in OCX configuration, like every other provider panel; usage retained under a provider no longer configured has no row.

`conditions` name only what this provider, model and input size actually price. `service-tier-priority` (priority and fast at 2x) is declared for OpenAI and xAI routes, but not for `gpt-5.4-mini`, whose priority rate is unverified, and not for xAI at or above its long-input threshold, where the combination is unverified. `service-tier-discount` (flex and batch at 0.5x) is OpenAI only. A tier the valuation refuses is never advertised, and no price is invented to match a label.

A configured credential is treated as a secret wherever it appears, not only inside the provider that declares it: the `apiKey` and pooled keys read from OCX configuration are excluded by value from `supportedModels`, `defaultModel`, `modelPrices[].model`, `unpricedModels[].model` and account labels. A value that is not in that configuration cannot be recognised by shape and is not guessed at.

A key counts as present when it stands as a complete piece of a value, delimited by whitespace or by the punctuation model syntax puts around a name (`/`, `:`, `[`, `]`, `~`). That is what keeps a decorated key out: `<key>[1m]`, `vendor/<key>:latest` and `hf:<key>` are all excluded, and every occurrence is scanned so a bounded later one is not missed. The in-word characters `-`, `.`, `_`, `+` and `@` are deliberately not delimiters, because a key of `gemini-3` must not delete `gemini-3.8-flash`; an earlier revision used a raw substring rule and it removed 126 real model names.

Two consequences are intended, and they pull against each other. A key written as a whole piece of a real model id removes that id, so configuring `k3` as an `apiKey` drops `k3[1m]` from the list. And a key wearing an in-word suffix, such as `<key>-x`, is not recognised at all. Tightening either one loosens the other, so both are stated rather than fixed: the rule leaves an ordinary model name alone unless the name literally contains a configured key as a whole piece. These residuals, and the dot-free relative path above, can arrive from the usage log as well as from configuration.

The pricing-source digest and normalized catalog revision trigger an idempotent replay from retained raw logs. Replay fills only null amounts with matching provider/model/time/token records, preserves already-priced amounts and original attribution, and honors retention and `historyResetAt`. Failed batches resume from their committed cursor without inflating invalid-line counts. Removed/rotated-away raw records cannot be recovered. Already-priced base amounts stay immutable; the Cursor cache and time-bounded Claude cache settings revalue eligible rows through `usage_valued`. Other historical repricing still requires a separately named data directory. The dashboard lists up to 20 unpriced models per provider and shows sub-cent amounts to six decimals so a small successful call does not round to $0.00.

### Devin SWE-2 reference valuation

The `devin` and `devin-cli` routes price the exact model `swe-2` at its published list rates: $3 input, $15 output and $0.30 cached input per million tokens ([Devin models](https://docs.devin.ai/desktop/models), checked 2026-09-15). This matches OCX's list-price comparison. Free self-serve periods and enterprise discounts do not turn the reference amount into an invoice or a zero token price. Cache reads are included in input and are subtracted before pricing uncached input. Cache-write pricing is unconfirmed, so positive writes stay unpriced; unreported tokens, unknown models and unsupported service tiers also stay unknown. Other providers cannot inherit this model's price.

The existing pricing revision replay fills matching previously unpriced records from retained raw logs. Original attribution, tokens, request counts and already-priced amounts are preserved. Model quotes carry the source date and `list-price-reference` condition. Missing or unreported usage cannot be reconstructed from the price table.

### Ollama legacy GPU quota

The collector polls the configured canonical Ollama `GET /api/usage` every 10 seconds with the existing API key (no inference requests). It persists only allowlisted quota fractions and per-model request counters in the monitor DB. Keys and raw API payloads are never exposed. API-key rotation starts a separate observation series. Session/weekly and migrated monthly windows remain distinct; missing reset timestamps are not invented.

Ollama calls retain input/output/cache tokens and latency per request. Published token prices provide a reference valuation, not legacy GPU billing. Existing unpriced Ollama history is replayed once with deduplication to populate reference values and timing records. Old request records are not assigned to the currently active API key.

Model calibration uses at least five minutes and 0.2 percentage points of net quota growth, contiguous samples, one changing model, and exact agreement between server request-counter growth and recorded calls. Counter drops, percentage drops, gaps, mixed models, and missing calls are excluded. Separate input/output amounts per percentage point describe the observed workload mix; they do not independently estimate GPU input/output coefficients. Rolling-window expiry can offset consumption, so these are net observed ratios, not exact per-call GPU charges. Latency includes queue/network time and is never treated as GPU time. Reset and exhaustion forecasts remain unavailable when the provider has not supplied the necessary reset data.

### Automatic provider refresh

Set `QUOTA_OPENCODEX_ORIGIN=http://127.0.0.1:10104` to the existing local OpenCodex management listener. Only an explicit HTTP loopback origin is accepted. The monitor reads `admin-api-token` locally, never serves it, and issues GET quota refreshes every 10 seconds. OpenCodex owns provider authentication and token renewal; no login, account selection, or inference endpoint is called.

OpenAI refreshes every native/pool account, OAuth providers refresh every stored account, and API-key providers use the per-key quota API. Anthropic quota normally refreshes every two minutes. A failed request, missing account or unavailable account backs off forced retries for two, four, then at most eight minutes; a healthy sibling does not bypass this delay. A complete successful lookup restores the two-minute cadence. Newer valid account observations can replace an older failed lookup while retries wait. The web reads the monitor every 10 seconds. During a quota refresh, the last completed result stays available until the next result is ready. New configured providers are discovered on each collection. Ollama retains its dedicated probe for model counters. A legacy bare key is matched to OpenCodex's exact key-ID projection, without publishing a key fingerprint. Normalized measurements are persisted in the monitor DB so API-key quotas survive a restart. Failed, missing, expired, or reauth-required responses never acquire a fresh observation timestamp. A transient lookup failure preserves recent measured values and their calculations. Account `status` and window `stale` describe measurement eligibility; optional `account.refresh` separately reports `status` (`ok` or `delayed`), `lastAttemptAt` and `nextAttemptAt` (nullable ISO timestamps). The next-attempt time is a schedule, not a guaranteed completion time. The management response does not expose the upstream error reason, so the dashboard reports lookup delay without claiming every failure is rate limiting. Values older than 15 minutes, future-dated values, elapsed reset windows, paused accounts and reauthentication requirements remain excluded from current calculations. Repeated cache reads never add new observation timestamps or manufactured idle history.

Recommendation estimates skip unpriced calls rather than blocking the whole provider. Partially valued quota capacities remain usable, with the result marked provisional. A recommendation requires priced usage and a measured weekly quota capacity.

## Interface

The default **요약** view presents each provider once: account count, average remaining quota by window, API-equivalent usage, and estimated account need. The 5-hour / 7-day / 30-day selector changes the usage period; it never changes or combines the provider's quota windows.

A provider opens its rolling usage totals and account rows. Each quota row aligns remaining percentage, estimated 100% API-equivalent limit, remaining equivalent and exhaustion estimate. Codex Spark windows are hidden in the web overview, account rows and details. Other model-specific and credit windows remain visible. This display choice leaves the API, collected history and usage totals unchanged. Unsupported conversions use `—`. Usage records, token breakdowns, forecasts, subscription ratios and calculation evidence are available in collapsed details.

API-equivalent amounts are reference estimates, not invoices or savings. `일부` marks a partially priced subtotal; `≈` marks estimated capacity. A subscription ratio is labeled `구독료 대비 환산액`. No recorded calls display `호출 없음`; unpriced calls display `단가 미확인`. Neither is silently converted to a measured zero.

Summary bars average fresh accounts with matching window ID, label and model scope. For example, 50% and 100% remaining average to 75%. This is equal-account normalization, not a plan-weighted pool. Paused, reauth and unavailable accounts are excluded. Observation age, reset expiry and percentage range are checked in the browser; one expired window does not invalidate a different fresh window on the same account. Account rows show the last measurement age separately from lookup delay and the next retry. Temporary lookup failures keep valid percentages, summary participation and estimates. Only expired or invalid measurement rows are muted and hide current estimates, with a concrete reason instead of an “이전 측정” badge.

Provider order is edited in the sidebar and saved to this browser. Sidebar, overview and all-account groups share that order. Unknown providers append in source order. At 760px and below the sidebar becomes an off-canvas drawer behind a top bar; the close button, the scrim and Escape close it, and the page behind it is `inert` so keyboard focus cannot reach it. Keyboard focus, selected period, search, ordering and open details survive refreshes. Search filters account rows; provider usage totals stay labeled as all-account totals.

The browser refreshes every 10 seconds while visible. A failed refresh retains the previous snapshot with a connection warning. Local expiry checks prevent offline snapshots from remaining current indefinitely. Usage totals and pace are anchored to the last successful log read; interrupted collection is not counted as idle time. `usageObservedAt`, `usageStale`, and per-provider `pace.observedAt` make that boundary explicit. Quota forecasts require the displayed percentage to match the last captured observation, and an observed 100% usage is exhausted even without a learned rate.

Design tokens and interaction rules: [DESIGN.md](DESIGN.md). Runtime dependencies and the `/api/v1/snapshot` version remain unchanged. The web service can be previewed without invoking the collector by importing `createApp` with a read-only snapshot callback; this isolates UI work from provider refreshes and persistent history writes.

Mac repair 0.1.1: the former fixed-parent render hid the initial 173-point popup size. The repair moves window sizing to an AppKit delegate and reserves a loading viewport. `QuotaPanelLayoutTests.swift` opens the actual NSPopover and tests delayed/long/short/reopen cases; it requires an unlocked Mac GUI session. `macos/build.sh` compiles and runs only `QuotaModelTests.swift`, so the layout harness must be compiled and run by hand. Remote locked-session failures are failures, not an interactive pass.

## License

[MIT](LICENSE). See [CONTRIBUTING](CONTRIBUTING.md) for changes and [SECURITY](SECURITY.md) for private vulnerability reporting.
