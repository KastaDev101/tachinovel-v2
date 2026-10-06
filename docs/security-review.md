# Security review

Date: 2026-10-06. Scope: the v2 app as it is on `main` (Swift layer, v2 web/core code, the v1 code it runs,
configuration, build and CI), against the [OWASP Mobile Top 10 (2024)](https://owasp.org/www-project-mobile-top-10/).
Method: code and configuration review, plus what the automated checks report (CodeQL default setup,
Dependabot alerts, secret scanning with push protection, the test suites). Not a penetration test.

TachiNovel has no account, no server and no payment data of its own; it reads public web pages and
stores a reading library on the device. The assets worth protecting are the user's library and reading
history (privacy), the integrity of the UI and core (they run code and content from the web), and the
device (nothing the app does should reach beyond its own sandbox).

## Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| SR-1 | The UI's WKWebView was inspectable in Release builds (`webContentsDebuggingEnabled: true`) | Medium | **Fixed**: unset; Capacitor makes it inspectable in Debug only (`CAPACITOR_DEBUG` from debug.xcconfig) |
| SR-2 | The `capacitor://localhost` file router served any decoded path: `..%2f` arrives as `../` and could read files outside the web bundle | Medium | **Fixed**: `TachiRouter` serves only files inside the bundle (standardized path prefix check); covers were already limited to flat names |
| SR-3 | Capacitor hands every top-level navigation leaving the app to `UIApplication.open`, whatever its scheme (tel:, sms:, other apps' URL schemes) | Low (content is sanitized, scripts blocked by CSP) | **Fixed**: `TachiNativePlugin.shouldOverrideLoad` lets only http(s) through (to Safari); other schemes are refused |
| SR-4 | Core log lines (they can name sources, novels, URLs) were written to the unified system log as `.public` in all builds | Low (privacy) | **Fixed**: `.public` in Debug only (CI smoke reads them), `.private` in Release; the app's own log file is unchanged |
| SR-5 | Cookie copy from the challenge WebView matched domains by bare suffix (`notexample.com` matched `example.com`) | Low (cookies keep their own domain, so nothing was sent to the wrong site) | **Fixed**: RFC 6265 domain match (`cookieDomainMatches`) |
| SR-6 | Deep links (`tachinovel://open?plugin=…&novel=…`) accepted any `novel`/`chapter` path for an installed source, including an absolute URL on another host, so another app or a web page could make the app fetch an arbitrary URL | Low | **Fixed**: the core rejects paths with control characters or backslashes, overlong paths, `user@host` authorities and absolute or scheme-relative URLs whose host isn't the source's site (`src/core/deep-link.ts`, tested) |
| SR-7 | Backup import reads the picked file whole; no size cap | Low (user-initiated; a huge file can only exhaust the app's own memory) | Accepted; v1 validates every field and bounds plugin settings. Revisit if imports from other apps are added |
| SR-8 | Dependabot alert #1: `uuid` (via `@capacitor/cli` → `xcode`), missing buffer bounds check | Low (dev-only CLI dependency, not shipped; the vulnerable `buf` argument isn't used) | Recommend dismissing as "tolerable risk"; it goes away when Capacitor's CLI updates `xcode` |
| SR-9 | CodeQL alerts on `main`: `js/bad-code-sanitization` in `tests/helpers/pc-shell.ts` (test helper) and `vendor/v1/src/script/lib/browser-post.ts`; `js/incomplete-multi-character-sanitization` in three `vendor/v1` files | Info | Triage: the test helper builds a script for a local test browser; v2 doesn't use v1's `browser-post` (its POST runs through `callAsyncJavaScript` with arguments, no string building); the `vendor/v1` ones are text clean-up, not HTML sanitizing (DOMPurify does that). Fix upstream in v1 or dismiss with these reasons |
| SR-10 | GitHub Actions are pinned to major tags (`actions/checkout@v7`), not commit SHAs | Low (supply chain) | Recommendation: pin to SHAs; Dependabot keeps SHA pins current |
| SR-11 | LNReader JS plugins (personal flavor) run in the core's JavaScriptCore context with v1's global shadowing, which is not a real sandbox | Info (by design) | Accepted for the personal flavor (trusted repositories only, documented). The store flavor has no JS plugin host at all |

## Notes by OWASP category

**M1 Improper credential usage.** No accounts, passwords, API keys or tokens in the app. The only secrets
are CI's App Store Connect key and signing material, read only by the `testflight` job on tags/manual
runs, never on pull requests (`pull_request`, not `pull_request_target`). Secret scanning and push
protection are on. Nothing is stored in the Keychain because there is nothing secret to store.

**M2 Inadequate supply chain security.** Locked npm dependencies (`npm ci`), Dependabot weekly with a
5-day cooldown and majors reviewed one by one, a test that every bundled npm package has a license notice,
SwiftLint downloaded by checksum, release IPAs with SHA-256 sums and build-provenance attestations. See
SR-8 and SR-10. User-added sources are the largest trust decision: the store flavor only accepts
declarative definitions (data, no code, `https` sites only); the personal flavor runs LNReader plugins
(SR-11).

**M3 Insecure authentication/authorization.** Not applicable (no accounts). In-app purchases use
StoreKit 2: entitlements are signed transactions verified on the device; there is no server to trust.

**M4 Insufficient input/output validation.**
- Chapter HTML from websites is sanitized with DOMPurify (allowlisted tags and attributes, no `href`,
  `style` or event handlers, `https:`/`data:image` URLs only) and the page has a strict CSP:
  `default-src 'none'`, one hashed script, `connect-src 'none'`, no frames or objects (tests/build.test.ts).
- The bridge exposes named methods only; v1's handlers validate every argument. The native host API
  rejects `..` in bundle reads, routes covers by flat file name and opens only http(s) URLs.
- Deep links: SR-6. Backups: SR-7. File router: SR-2.

**M5 Insecure communication.** App Transport Security is on with no exceptions: every connection to a
host name is HTTPS with a valid certificate (source definitions must be `https`). No certificate pinning,
which would not fit an app that reads arbitrary third-party sites. Cookies set by sites live in the
shared cookie store and only go back to their own domains (SR-5).

**M6 Inadequate privacy controls.** No tracking, no analytics, no data collected (privacy manifest,
checked by tests/privacy-manifest.test.ts). The library, history and logs stay on the device or in the
user's own iCloud; diagnostics and backups leave only through the share sheet. SR-4 keeps reading
activity out of the system log in Release builds.

**M7 Insufficient binary protections.** SR-1. The core's JSContext is inspectable in Debug builds only.
The binary holds no secrets, so the public unsigned IPA exposes nothing beyond the (public) source code.

**M8 Security misconfiguration.** Info.plist declares only what is used (background audio and fetch,
the `tachinovel` URL scheme, the BG task id); `App.entitlements` is empty for sideloading; CapacitorHttp
is off (the UI never fetches); navigations are restricted (SR-3). App-Bound Domains stay off: the app
doesn't inject scripts into third-party pages in its UI web view, and the hidden challenge WebView has no
bridge or message handlers.

**M9 Insecure data storage.** Data lives in Application Support (caches, covers, downloads and imports
are excluded from iCloud Backup) and, when available, the app's iCloud Documents container. iOS Data
Protection (default class) encrypts it at rest. No secrets are stored; backups are plain JSON on purpose
(the user's own data, portable between v1 and v2).

**M10 Insufficient cryptography.** The app implements no cryptography; TLS comes from the OS.
`ITSAppUsesNonExemptEncryption = false` is accurate.

## Re-checking

- On every pull request: CodeQL, the CSP and flavor tests (tests/build.test.ts), the privacy manifest
  test, the deep-link and router checks (tests/security.test.ts), ESLint's context rules.
- Before a store submission: re-run this review, resolve SR-8 to SR-10, and review any ad SDK (it changes
  M6 and M8).
- Report vulnerabilities privately: [SECURITY.md](../SECURITY.md).
