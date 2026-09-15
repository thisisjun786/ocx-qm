# Security

OCX QM is a local dashboard with read-only provider access. Run it on loopback or a private Tailscale network. It has no application login; Host/Origin checks do not authenticate users. Publishing source code does not make a running dashboard safe to expose publicly.

Provider configuration and credentials stay local. The collector can make authenticated quota GET requests; it never performs inference, login or account switching. The history and subscription SQLite files are private data. The subscription PUT route changes only local plan selections and requires same-origin JSON requests; it has no separate user login. Anyone trusted to access the server can read usage and change these preferences. Do not attach it, raw provider files, tokens or account screenshots to an issue.

## Reporting

Use the repository's Security → Report a vulnerability action when private reporting is enabled. If it is unavailable, open an issue requesting a private reporting channel without including exploit details or sensitive data. Do not post credentials or raw operational logs publicly.

Include the affected revision, a minimal synthetic reproduction, expected/actual behavior and impact. No response-time guarantee is offered. Security fixes target the current main branch; older versions have no separate support commitment.
