# OCX QM agent guide

- Read [POLICY.md](POLICY.md) before branch, CI, merge or release work. Start from current `origin/dev`; normal PRs target `dev`. Main promotion needs explicit owner instruction.
- Node.js >=24 ES modules, no third-party runtime dependencies. Browser HTML/CSS/JS is served directly; no framework or frontend build. `npm run check`, `npm test`, `npm run check:ci`.
- Use task-owned `codex/*` branches and isolated worktrees in the contributor’s configured worktree root. Preserve other tasks' dirty work and operational data.
- `src/snapshot.mjs` projects read-only OCX sources; `identity.mjs` owns usage attribution; `history.mjs` owns SQLite history; `subscriptions.mjs` owns the separate official-plan/settings DB. Never write to provider credentials or source account files.
- Preserve snapshot schema version 1 compatibility, identity boundaries, unknown/null values and additive analytics. Do not combine unrelated quota periods/providers or infer physical identity from an account slot.
- Subscription choices bind to physical identity and require current `selectionContext`; source prices carry URL/check date. No custom amount or automatic detected-tier fallback. Keep API model pricing separate from subscription fees.
- Follow [DESIGN.md](DESIGN.md) for Korean utility UI, tokens and uncertainty. Reuse `public/` modules; browser changes need the existing real Chromium harness and synthetic screenshots.
- `npm run check:ui` uses `QUOTA_UI_CHECK_CHROME` when Chromium is not on PATH. Tests use temporary files/databases and ephemeral loopback ports; no paid or credentialed live calls.
- Native build: `bash macos/build.sh` on macOS. Model/build checks do not certify installed UI behavior; the layout harness needs an unlocked GUI session.
- Host/Origin guards are not login. Keep the dashboard on loopback/private tailnet. Never expose credential fields, raw server errors or arbitrary static files.
- CI controls live in `scripts/ci/` and `tests/ci/`; policy/control changes must remain in full-check selection. Validate changed workflows with actionlint and cover fail-closed gates.
- Treat source checks, hosted CI, installed artifacts and live behavior as different evidence. Record what ran and material gaps; do not deploy, publish releases or change operating data without authorization.
