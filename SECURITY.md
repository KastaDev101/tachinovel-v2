# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue or pull request:

1. Open the repository's **Security** tab and choose **Report a vulnerability**
   (https://github.com/KastaDev101/tachinovel-v2/security/advisories/new). Private vulnerability
   reporting is enabled, so only the maintainer sees the report.
2. Describe the problem, the affected version or commit, and how to reproduce it. A proof of concept
   helps; please use synthetic data, never someone's real library or backup.

What to expect: an acknowledgement within 7 days, an assessment within 30 days, and credit in the
advisory and the changelog if you want it. This is a one-person project with no bug bounty.

## Supported versions

TachiNovel v2 is pre-release. Fixes go into `main` and the next release; older builds and tags are not
patched.

| Version | Supported |
|---|---|
| `main` and the latest release | Yes |
| Anything older | No |

## Scope

In scope: the iOS app in this repository (Swift layer, web UI, script core), its build and CI
configuration, and the release artifacts built from it. Examples: script injection through chapter HTML
or source definitions, escaping the source sandbox, reading files outside the app's own folders,
unvalidated deep links or backup imports, secrets in logs or artifacts.

Out of scope: the third-party websites that sources read from, LNReader plugins and repositories you
add yourself (only add sources you trust), and vulnerabilities in iOS, WebKit or third-party libraries
that are already public (report those upstream; tell us if we need to update).

The app's own security model is described in [docs/architecture.md](docs/architecture.md) §4.
