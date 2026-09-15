# Contributing to OCX QM

Use Node.js 24 or newer. The server and browser have no runtime dependencies or build step.

1. Read [POLICY.md](POLICY.md), then create a focused branch from current `origin/dev`. Normal PRs target `dev`.
2. Preserve schema version 1, unknown values and the read-only provider boundary. Keep original usage attribution and history intact.
3. Run `npm run check` and `npm test`. For browser changes, run `QUOTA_UI_CHECK_CHROME=/absolute/path/to/chromium npm run check:ui`; the harness serves synthetic data and does not start the collector.
4. For native changes, run `bash macos/build.sh` on macOS. The separate popover layout harness requires an unlocked GUI session.
5. Open a pull request to `dev` explaining the problem, resulting behavior, checks actually run and remaining limitations.

Use synthetic accounts and usage in tests. Do not include provider files, credentials, real account identifiers, private hostnames, usage exports or screenshots of real accounts. Keep logs outside the checkout. Scan the proposed content and Git history before publishing a branch; removing a value from the latest file does not remove it from old commits.

Price changes need provider/model scope, units, a primary source and a check date. Reference API value is not a bill. A missing price or quota is not measured zero.

See [README](README.md) for contracts, [DESIGN](DESIGN.md) for UI terms and [SECURITY](SECURITY.md) for sensitive reports. Contributions are licensed under [MIT](LICENSE).

CI policy and control changes also require `npm run check:ci` and `actionlint .github/workflows/ci.yml`. The required result is `dev-gate`; only an explicitly authorized same-repository `dev -> main` promotion uses `release-gate`. Merge commits preserve release ancestry.
