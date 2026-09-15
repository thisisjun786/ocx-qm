# OCX QM development policy

OCX QM is maintained by one owner with agent assistance. This repository owns its
policy; Lina is a reference, not a runtime or CI dependency. Prefer small changes,
short feedback loops and deliberate releases. [AGENTS.md](AGENTS.md) defines code
contracts; [CONTRIBUTING.md](CONTRIBUTING.md) explains contribution steps.

## Branches and authority

| Target | Purpose | Required check | Merge method |
| --- | --- | --- | --- |
| `dev` (default) | Integrate normal feature and fix PRs | `dev-gate` | Merge commit |
| `main` | Promote this repository's `dev` branch | `release-gate` | Merge commit |

Start short-lived `codex/*` branches from current `origin/dev`, preferably in an
isolated worktree. Normal PRs target `dev`; intermediate dependent PRs also receive
development CI. Do not register native stacks unless explicitly requested.

Merge only a ready PR whose current combined candidate passes its required gate,
is up to date with the target, has no conflicts, has resolved review conversations,
and has no confirmed material defect. Read current head/base before merging and use
an expected-head guard. If either changes, verify the new candidate. Never force
push shared work, push directly to protected branches or bypass protection.

Required human review count is zero. Automated reviews are advisory and have no
mandatory waiting period; confirmed defects still need resolution. An agent may
complete a `dev` merge within the user's authorized delivery scope. Review-only,
local-only and explicit merge holds remain limits. Do not request authorization
again for an action already authorized.

Every `dev -> main` promotion requires explicit owner instruction for that
promotion and release notes. CI rejects other heads and same-name branches from
forks. Urgent fixes also go through `dev`. Passing CI does not authorize tags,
publication, deployment, paid provider calls or changes to installed data.

## Verification and cost

The workflow is `changes -> independent checks -> result-only gate`.

| Job | Evidence |
| --- | --- |
| `changes` | CI-control tests, complete-history secret scan, full PR diff and merge-candidate identity |
| `check` | Node syntax checks for every server, browser, script and test module |
| `tests` | All application tests with isolated synthetic data and temporary stores |
| `browser` | Real Chromium dashboard, SQLite settings, input/retry/reload and responsive checks |
| `macos` | Swift model tests and actual macOS app build/signing with a local ad-hoc signature |
| `dev-gate` / `release-gate` | Successful selection and every selected prerequisite |

Development can skip application jobs only when every changed path is in the
exact prose allowlist in [plan.mjs](scripts/ci/plan.mjs). `POLICY.md`, `AGENTS.md`,
CI configuration, dependency/config files, unknown paths, mixed diffs and empty
diffs run every check. Both sides of renames and deletions count. Unreadable
history or malformed selection fails. Every main promotion runs all checks.

Jobs test GitHub's combined merge candidate. Gates run even after prerequisite
failures and reject missing, malformed, cancelled, failed or unexpected skipped
results. Only jobs explicitly excluded by selection may be skipped. A gate does
not install the app or rerun tests. CI scripts have adversarial tests, including
real temporary Git history and changed candidate identities.

Use the smallest meaningful local checks; an extra full local suite before every
PR is not mandatory. CI-control edits need selector/gate negative tests and workflow
validation (`actionlint`). Do not repair flakes by blind reruns or longer sleeps.

Use hosted Ubuntu and macOS runners, pinned Node and Action revisions, bounded
timeouts, read-only tokens and independent state. Cancel obsolete runs of the same
PR. Avoid duplicate feature-push suites, shards, self-hosted runners, privileged
`pull_request_target` execution and merge queues. This project needs macOS CI
because it ships a Swift client; Linux success cannot substitute for a native build.

The app has no third-party runtime dependencies or frontend build pipeline. Do not
add Bun, a framework, an install step, cache or dependency-audit ceremony without
an actual dependency. A future dependency change must add a committed lockfile,
reproducible installation and vulnerability checks appropriate to that dependency.
CXC and paperthin are contributor tools, never ordinary CI prerequisites.

Secret scanning uses the pinned, checksum-verified Gitleaks release in
[scripts/ci/secrets.sh](scripts/ci/secrets.sh). Scan all available Git history and
merge diffs, ignoring inline allow comments and repository ignore files. Add only
reviewed exact synthetic value/path exceptions; never baseline away unknown leaks.
Scanner and workflow changes require review. A clean scan does not prove that all
private information or vulnerabilities are absent.

## Product and release evidence

Provider/account sources remain read-only. CI never logs into providers, makes
inference calls, purchases subscriptions, changes account selection upstream or
uses production credentials. Quota/history/settings tests use isolated synthetic
files, SQLite databases and ephemeral loopback ports.

Preserve snapshot schema version 1 and existing identity/history. Official
subscription prices are source-dated data; missing, stale and unselected prices
are not zero. API-equivalent value is not a bill. Model prices, subscription fees
and quota percentages must not be substituted for each other.

Source CI does not certify a live provider, deployed dashboard, installed macOS UI,
notarized distribution or actual billing. Releases promising those capabilities
need corresponding platform or live evidence and separate authorization. Keep
provider files, credentials, real account IDs, private hostnames and operational
screenshots out of commits and public logs. Preserve dirty work and report local,
CI, merge, release and deployment states separately.

## GitHub enforcement

The checked-in workflow alone does not protect branches. Activate a ruleset on
`dev` requiring `dev-gate` and one on `main` requiring `release-gate`. Both require
PRs, resolved conversations, current-base checks and merge commits, with zero
mandatory approvals, no bypass actors, and deletion/force-push protection. Bind
required checks to GitHub Actions. Keep squash/rebase merge disabled and `dev` as
default. Keep automatic head deletion disabled so a release cannot delete `dev`;
clean task branches only after checking ownership and merged ancestry.

Read rulesets and classic branch protection back after setup; do not claim
activation from files alone. Bootstrap `dev` from the reviewed existing `main`,
land this policy via a verified PR to `dev`, and preserve the release line until
an explicitly authorized promotion. Do not recreate a central policy service.

After a promotion, reconcile the new `main` merge commit into `dev` through a PR
before the next promotion. Do not synchronize protected branches with a direct push.
