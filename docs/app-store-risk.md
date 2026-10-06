# App Store review risk — TachiNovel v2

Status: research and analysis, 2026-10-06. Not legal advice. Every factual claim cites a source with its
publication date, or "acc. 2026-10-06" (accessed) when the page has no date. Risk percentages are
judgement calls, not data; the reasoning is next to each.

## Bottom line

1. **v1 as it is cannot go on the App Store.** Shipping the LNReader plugin repository (or Stonescape)
   preconfigured is a direct hit on guidelines 5.2.1/5.2.2 (third-party content) and 2.5.2 (downloaded
   code), and since November 2025 guideline 4.7 makes the app responsible for every plug-in it runs.
   Adding ads and a paid tier on top of that content is the pattern Apple and rights holders act on
   (Musi, the Kadokawa-targeted manga apps). Estimated rejection or later removal: **85–90%**.
2. **"Empty shell, user adds any repo" has survived for years (Paperback, Tachimanga) but is a coin flip
   for a new, monetized submission in 2026.** The rules got stricter after those apps were approved
   (4.7 rewrite, Nov 13, 2025). Estimated **45–60%** (JS plug-ins) / **35–50%** (declarative data
   sources, what the v2 store flavor implements).
3. **The low-risk store app is a different product:** a reader + narrator for content the user owns or
   that is licensed/public domain (EPUB/TXT import, OPDS servers, Project Gutenberg / Standard Ebooks
   catalogs, sources with written permission). Estimated **5–15%**, but it has to win users on its own
   merits (TTS, reader polish), not on "every web novel for free".
4. **Your personal use is safe without the App Store:** a TestFlight **internal** build for yourself
   needs no App Review and keeps every v1 feature. This is the `personal` flavor (docs/roadmap.md).
5. **Royal Road is the wrong "legitimate default".** It forbids scraping in its ToS and sells the same
   features (ad-free, offline, TTS) in its own iOS app. Asking permission is fine; assuming it is not.

## 1. What a reviewer would see

| Feature (v1 behaviour) | Review-relevant fact |
|---|---|
| Sources = LNReader plugins (JavaScript) from a GitHub index, installed in-app | Downloaded executable code (2.5.2); plug-ins (4.7); third-party content (5.2) |
| Built-in Stonescape source (rehosts translated novels/manhwa, coin-locked chapters) | Third-party content without demonstrable permission (5.2.1/5.2.2) |
| Browse/search/read any site the plugins scrape; global search across sources | "Content aggregator" (4.2.2); monetizing access (5.2.2) |
| Offline downloads of chapters | "Saving … media from third-party sources" (5.2.3) |
| TTS narration (v2), background audio, CarPlay | 2.5.4 background audio must be legitimate (it is, but must be demonstrable); CarPlay entitlement |
| Ads + "Pro" (v2 plan) | 3.1.1 IAP; 5.1.2 ATT; 2.5.18 ads rules; raises the stakes of 5.2.2 ("monetizes access") |
| Mature content on many novel sites | Age rating; "Unrated" content can't be published |

The v2 **store flavor** already removes the worst items in code (tests/build.test.ts asserts them):
no built-in sources, no preconfigured repository, no LNReader verification table, and **no JavaScript
plugin host in the binary** — sources are JSON definitions read by a fixed engine
(src/core/declarative/). What remains is the content question, which code cannot solve.

## 2. Guideline by guideline

Guidelines text: https://developer.apple.com/app-store/review/guidelines/ (acc. 2026-10-06; the page
carries no date). Latest announced revision **June 8, 2026** (kids/teen intro, new developer-
responsibility paragraph in 1.2, 4.3(a)/(b) clarified, 4.5.3) — https://developer.apple.com/news/?id=a233fmpw.
Earlier: Feb 6, 2026 (https://developer.apple.com/news/?id=d75yllv4); **Nov 13, 2025: 4.7 covers
HTML5/JavaScript mini apps, new 4.7.2 and 4.7.5, new 1.2.1(a), 5.1.2(i) third-party AI**
(https://developer.apple.com/news/?id=ey6d8onl); May 1, 2025: US link-outs in 3.1.1(a)/3.1.3
(https://developer.apple.com/news/?id=9txfddzf).

### 5.2 Intellectual property — the deciding issue
- **5.2.1:** don't use protected third-party material without permission. **5.2.2:** an app that uses,
  accesses, monetizes access to, or displays content from a third-party service must be specifically
  permitted by that service's terms, and must show the authorization on request. **5.2.3:** no saving,
  converting or downloading media from third-party sources without explicit authorization.
- A reader that fetches chapters from websites and shows them in its own UI with its own ads is
  squarely "displays" and "monetizes access to". Nothing in the architecture changes that — whether the
  fetch rule is a JS plugin or a JSON spec, the content is the site's.
- Enforcement is **complaint-driven**: Apple forwards IP complaints (App Store Content Dispute form,
  https://www.apple.com/legal/intellectual-property/dispute-forms/app-store, acc. 2026-10-06) and removes
  apps when disputes aren't resolved. 2025 Transparency Report: 1,177 apps removed for IP infringement
  (DPLA 6.3), no breakdown by category (https://apple.com/legal/app-store/transparency/2025, acc.).
- Courts back Apple's discretion: Musi's suit over its Sept 2024 removal was dismissed with prejudice on
  Mar 16, 2026; the agreement lets Apple delist "with or without cause"
  (https://www.musicbusinessworldwide.com/apple-wins-dismissal-of-lawsuit-from-streaming-app-musi-over-2024-app-store-removal, Mar 2026).
- **Identity exposure:** rights holders have used DMCA subpoenas to get developer names, addresses and
  payment details from Apple and Google (Kadokawa vs manga apps,
  https://torrentfreak.com/manga-piracy-apps-stay-up-on-google-apple-publisher-moves-to-unmask-devs-230817/, Aug 17, 2023).

### 2.5.2 code download, and 4.7 plug-ins
- **2.5.2:** apps must be self-contained; no downloading/installing/executing code that introduces or
  changes features or functionality. The text names no WebKit/JavaScriptCore exception today
  (guidelines page, acc. 2026-10-06).
- **DPLA 3.3.1(B)** historically allowed interpreted code that doesn't change the app's primary purpose
  or create a storefront (The Register, https://www.theregister.com/2017/06/07/apple_relaxes_developer_rules/,
  June 7, 2017; current text not re-verified, the agreement page fetch was truncated —
  https://developer.apple.com/support/terms/apple-developer-program-license-agreement/).
- **4.7 (rewritten Nov 13, 2025)** lets apps offer software not embedded in the binary, explicitly
  including "HTML5 and JavaScript mini apps" and plug-ins, but: the app is responsible for that
  software's compliance (4.7), must filter/report/block objectionable material and use IAP for digital
  goods (4.7.1), **may not expose native platform APIs to it without permission (4.7.2)**, needs
  per-instance consent before sharing data (4.7.3), must publish an index of offered software with
  universal links (4.7.4), and must flag software above the app's age rating behind an age gate (4.7.5).
- LNReader plugins are plug-ins under 4.7, and v1's design gives them native networking with no CORS —
  arguably exactly what 4.7.2 forbids. 4.7.4/4.7.5 cannot be met for arbitrary user-added repos.
- **Declarative specs (store flavor)** move the argument from "downloaded code" to "downloaded data",
  similar to RSS or Safari content-blocker rules. That is materially better on 2.5.2/4.7, but not a free
  pass: Apple has applied 2.5.2 to remote data that changes app behaviour
  (https://developer.apple.com/forums/thread/821927, Apr 2026). Keep specs boring: selectors, URL
  templates, no expression language, no scripting hooks.

### 4.2 minimum functionality / 4.3 spam
- 4.2.2: apps shouldn't primarily be "web clippings, content aggregators" (guidelines, acc. 2026-10-06).
- An app that does nothing until the user pastes a repository URL invites a 4.2 rejection ("the app has
  no content") — and pointing the reviewer at a pirate repo to "demonstrate" it is worse. The app needs
  standalone value at first launch: EPUB/TXT import, OPDS catalogs, public-domain catalog, TTS.
- 4.3 (clarified June 2026) warns that low-value, look-alike categories may be removed. A "Tachi*"
  reader clone is in a crowded category; the name also invites association with Tachiyomi. **Pick a
  neutral brand for any store build.**

### 3.1 payments
- Unlocking features or removing ads must use IAP (3.1.1); auto-renewables need ongoing value and a
  ≥7-day period; you can't take away features people already paid for (3.1.2(a)) — the trap Voice Dream
  hit when it moved paid users to a subscription (docs/monetization.md).
- US storefront link-outs are allowed (3.1.1(a)); the commission question is still in litigation (Ninth
  Circuit Dec 11, 2025, https://law.justia.com/cases/federal/appellate-courts/ca9/25-2935/25-2935-2025-12-11.html;
  Supreme Court cert granted June 30, 2026,
  https://ipwatchdog.com/2026/06/30/high-court-grants-cert-in-apples-challenge-to-ninth-circuit-contempt-ruling-in-app-store-dispute/).
  Not worth it for a small app (docs/monetization.md).

### 5.1 privacy
- Privacy policy, data minimization, ATT before tracking; 5.1.2(i) now also covers sharing with
  third-party AI (relevant if cloud TTS or AI translation is ever added).
- EU: an alternative ATT prompt becomes optional in the EU and mandatory in DE, FR, IT, PL, RO from
  iOS 27.2 (https://developer.apple.com/news/?id=idsft9ai, Sept 16, 2026).
- With ads: AdMob data types in the privacy label, UMP consent in the EEA/UK/CH (docs/monetization.md).

### 1.x content and age rating
- New tiers 4+/9+/13+/16+/18+. "Unrestricted web access" → at least **16+**; frequent mature themes →
  18+; graphic sexual content → "Unrated", which **can't be published on the App Store**
  (https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/, acc. 2026-10-06).
- Many web-novel sites host explicit fiction. A source system must be able to hide adult sources/genres
  and age-gate (4.7.5). Tachimanga and Paperback are rated 16+ (their App Store pages, acc. 2026-10-06).

### 2.5.4 background audio, 2.5.18 ads, 2.3 metadata, 5.6 honesty
- **2.5.4:** background modes only for their intended purpose. A TTS reader qualifies, but reviewers
  must be able to see it: a text reader using AVSpeechSynthesizer was rejected three times until the
  developer sent a screen recording and added onboarding (https://developer.apple.com/forums/thread/826849,
  May 2026). → Put a lock-screen demo video in the review notes.
- **2.5.18:** ads must suit the age rating, interstitials need a visible close button, and apps with ads
  must let users report inappropriate ads (added June 5, 2023,
  https://appleinsider.com/articles/23/06/06/app-store-review-guideline-updates-go-after-fake-apps-bad-ads).
- **2.3.7/2.3.8:** no third-party trademarks (Royal Road, Webnovel, …) in name, keywords or screenshots.
- **5.6.1:** don't mislead review. Hiding the source system from the reviewer and enabling it later is
  the classic way to lose the **whole developer account**, which would also kill the personal TestFlight
  build. Be candid in review notes, or don't ship the feature.

## 3. Precedents (iOS and the Tachiyomi family)

| App | Channel | Key dates | What happened | Sources/extensions | Source |
|---|---|---|---|---|---|
| **Tachimanga** | iOS App Store, id6447486175 | live; v5.0 Sept 6, 2026; not in mainland China since Apr 22, 2024 | Live for years. Seller Tekbrio LLC; **16+**; free with ads + Premium ($1.99/mo, $9.99/yr, $24.99–29.99 lifetime); privacy label lists tracking identifiers | Store description mentions only ZIP/CBZ/EPUB and Komga; its website documents user-added extension repos. How it executes extensions on iOS is undocumented | https://apps.apple.com/us/app/tachimanga/id6447486175 ; https://tachimanga.app/help/guides/repositories.html ; https://applecensorship.com/app-store-monitor/app/6447486175 (acc. 2026-10-06) |
| **Paperback** | App Store id1626613373; earlier AltStore (Apr 2020), TestFlight | 0.8.11 Feb 28, 2025 | Live. Seller is an individual; 16+; **free, no ads, no IAP**, "no data collected" | Description mentions a TypeScript/JavaScript scripting API; ships no content; users add repos | https://apps.apple.com/us/app/paperback-comic-manga-reader/id1626613373 ; https://paperback.moe/getting-started/installation/ ; https://twitter.com/paperbackios/status/1252515508311777281 |
| **Aidoku** | TestFlight, AltStore (not PAL), IPA | — | Never on the App Store; says AltStore PAL is "not supported" | WASM sources, user-added lists | https://github.com/Aidoku/Aidoku ; https://aidoku.app/help/guides/getting-started/ (acc.) |
| **Suwatte** | TestFlight only | — | App Store release "planned", no date | External "runners" | https://github.com/suwatte/app (acc.) |
| **Tachiyomi** (Android) | GitHub | Kakao contact Jan 2, 2024; ended Jan 13, 2024 | Kakao Entertainment demanded the project and forks be destroyed | Extension repo removed | https://torrentfreak.com/tachiyomi-manga-reader-how-threats-can-motivate-pirates-boost-engagement-240113/ (Jan 13, 2024) |
| Mihon / Keiyoushi | Android | FAKKU DMCA Mar 23, 2026 | §1201 DMCA against extension repos; adult sources removed | User-added repos | https://github.com/github/dmca/blob/master/2026/03/2026-03-23-fakku.md |
| Aniyomi | Android | June 2024 | Sony DMCA removed 200+ extensions | Repo | https://torrentfreak.com/sony-dmca-notice-nukes-200-aniyomi-extensions-as-tachiyomi-fork-feels-heat-240617/ (June 17, 2024) |
| Kotatsu | Android | archived Nov 4, 2025 | Shut down citing Kakao "threatening actions" and Google sideloading policy | 1,200+ built-in sources | https://github.com/KotatsuApp/Kotatsu (acc.) |
| Kadokawa-targeted manga apps | iOS + Google Play | notices June 16, 2023; removed later (reported Mar 30, 2024) | Stores didn't act at first; publisher subpoenaed developer identities; apps removed after legal action | Built-in pirate sources | torrentfreak link above; https://www.animeclick.it/public_html/public/app.php/news/102866-lindustria-manga-giapponese-affronta-il-problema-della-pirateria-allestero |
| **Musi** (closest analogue) | iOS | removed Sept 2024; suit dismissed Mar 16, 2026 | Removed after NMPA/Sony Music/IFPI complaints; showed YouTube audio in its own UI with its own ads | Third-party content in own UI | musicbusinessworldwide link above |
| TV Time | iOS | removed Nov 1, 2024, reinstated | Fast takedown over a DMCA complaint | — | https://appleinsider.com/articles/24/11/20/apples-quick-app-store-takedowns-over-copyright-claims-are-a-nightmare-for-developers (Nov 20, 2024) |
| Unofficial AO3 readers | iOS + Play | outcry Feb 2020; one live today | AO3 said authors must file DMCA themselves; a subscription "AO3 unofficial" app is live today | Built-in scraping | https://archiveofourown.org/admin_posts/15103 (Feb 17, 2020); https://apps.apple.com/us/app/fanfict-reader-ao3-unofficial/id6667102594 (acc.) |
| Light Novel – Offline Reader | App Store | v3.20.0 Aug 30, 2025 | Live; ads + VIP up to $79.99; TTS | Claims public-domain/open-license content (unverified) | https://apps.apple.com/us/app/light-novel-offline-reader/id1524146384 (acc.) |
| **Royal Road** (official) | App Store id6456945333 | v2.53 Sept 2026 | Live; 13+; ads; Premium $3.49/mo = ad-free + offline; TTS | First party | https://apps.apple.com/app/id6456945333 (acc.) |

**Lessons.** (1) Survivors present themselves as *readers* (local files, Komga/OPDS) and keep source
management low-key; none ship content. (2) Paperback — the cleanest example — earns nothing; Tachimanga
monetizes and is run by an LLC. (3) Removal follows complaints, and complaints follow visibility and
money. (4) The Tachiyomi ecosystem's legal pressure comes from publishers (Kakao, Sony, FAKKU), the same
companies whose translated novels fill aggregator sites. (5) No documented case was found of a
web-novel scraper app pulled specifically over Webnovel or Wuxiaworld complaints — absence of evidence,
not evidence of safety.

## 4. Would "legitimate" sources give permission?

| Site | Terms (as found) | Own app / monetization | Assessment | Source |
|---|---|---|---|---|
| Royal Road | ToS bans scraping/crawling/caching and exceeding human request rates (search-engine index of the ToS; direct fetch returned 403 — partly verified) | Official iOS app: ads, Premium $3.49/mo (ad-free + offline), TTS | Competes head-on; a complaint is plausible; permission unlikely but askable (author-facing API/partnership) | https://www.royalroad.com/tos ; https://apps.apple.com/app/id6456945333 (acc.) |
| Scribble Hub | ToS updated Aug 31, 2026; authors license content for distribution "only through our services"; mentions its own iOS app and "Scribble Hub Plus" | Own app + subscription | No third-party license from authors; permission unlikely | https://www.scribblehub.com/terms-of-service/ (acc.) |
| Wattpad | Bans crawling/spidering, reproduction without consent, competing use | Own apps | No | https://policies.wattpad.com/terms/ (May 13, 2019) |
| AO3 | No public API; authors hold copyright | — | No permission possible centrally | https://secure.archiveofourown.org/admin_posts/3390 (Aug 7, 2015) |
| Project Gutenberg | Automated website access → IP block; use catalogs/mirrors/offline feeds instead | Public domain (US) | **Yes**, via catalog/mirror, not by scraping | https://www.gutenberg.org/policy/robot_access.html (acc.) |
| Standard Ebooks | OPDS feeds; "New releases" public, other feeds for Patrons Circle | Public domain | **Yes** (public feed) | https://standardebooks.org/feeds (acc.) |
| User's own OPDS/Komga/Calibre server | User's content | — | **Yes** (Tachimanga and Paperback lead with Komga) | — |
| Individual authors / small sites | Written permission possible | — | **Yes**, case by case; keep the emails | — |

## 5. What a compliant v2 must change

Done in the scaffold (store flavor):
- [x] No bundled sources, no preconfigured repo, no plugin verification table (tests/build.test.ts).
- [x] No JavaScript plugin host in the binary; sources are declarative JSON specs (src/core/declarative/).
- [x] Plugins/specs run in the core JSContext with `__native` removed from globals; the UI WebView has a
      strict CSP and never fetches.
- [x] Paywall gates app features only, never access to sources or chapters (src/ui/monetization/entitlements.ts).
- [x] Ads never shown while reading or listening (src/ui/monetization/ad-policy.ts).

Still required before a submission:
1. **Standalone value at first launch:** EPUB/TXT import, OPDS client (Komga/Calibre/Standard Ebooks),
   Project Gutenberg catalog (catalog files, not scraping), TTS on all of it. Otherwise 4.2.
2. **Only permitted network sources enabled by default**, each with an attribution line and the written
   permission on file (5.2.2 "show authorization on request").
3. If user-added sources stay: the 4.7 controls — content filter for adult sources/genres, report and
   block, a per-source consent sheet, an index page of known specs with universal links (4.7.4), and an
   age gate using the Declared Age Range API (4.7.5; https://developer.apple.com/support/age-assurance/).
   Decide whether you want this at all (decision D3 in roadmap.md).
4. **No audio export** of narrated third-party text (5.2.3); narration stays a live, in-app feature.
5. **Downloads:** offline copies only for owned/licensed/public-domain content, or keep them as a
   cache-like feature with no paywall attached (docs/monetization.md explains why downloads are not a
   Pro lever).
6. **Age rating 16+** (or 18+), and an honest questionnaire.
7. **Neutral name, copy and screenshots** (no "Tachi", no third-party logos; the v1 UI still says "Paste an
   LNReader plugin" and "running in Scriptable" — roadmap.md lists the copy change), privacy policy,
   support URL.
8. **Review notes** that explain the source model plainly, plus a lock-screen narration video (2.5.4).
9. **Ads only after the content model is clean.** AdMob also polices copyright: ad serving can be
   disabled without warning for infringing content (https://support.google.com/admob/answer/6128543, acc.).

## 6. Risk score per approach

| # | Approach | Rejection or removal risk | Why |
|---|---|---|---|
| A | v1 as is: LNReader repo preconfigured (+ Stonescape) | **85–90%** | 5.2.1/5.2.2/2.5.2 direct; 4.7 liability for every plugin; aggregator + ads looks like Musi / Kadokawa cases |
| B | No sources, user adds any repo of **JS plugins** (Paperback model) | **45–60%** (30–50% at review + 20–35% later) | Paperback/Tachimanga precedent, but approved under older rules; 4.7.2/4.7.4/4.7.5 hard to meet; ads raise complaint odds; Aidoku/Suwatte chose not to try |
| C | User-added **declarative** sources (v2 store flavor today) | **35–50%** | Better on 2.5.2/4.7; same 5.2 exposure as B; Apple has applied 2.5.2 to remote data; many sites need JS so coverage drops |
| D | **Curated, permitted sources only** + import/OPDS/public domain + TTS | **5–15%** (with permissions in hand) | 5.2.2 satisfied; residual risk is 4.2/4.3 (must be a good reader) |
| E | **TestFlight internal, personal use** (v1 parity, `personal` flavor) | **~5–10%** account-level risk | Internal builds skip Beta App Review; 90-day builds re-uploaded by CI; risk is Apple noticing a build that isn't meant for public release (2.2) |
| E′ | TestFlight **external** to friends with the LNReader repo | 40–60% | First external build goes through Beta App Review against the full guidelines |
| F | AltStore PAL (EU/Japan/Brazil, notarized) | 30–50% JS / 15–30% declarative | Notarization covers 2.5.2/4.7 and probably 5.2; Apple revoked notarization before (iTorrent, https://www.macrumors.com/2025/08/27/apple-blocks-itorrent-app-eu/, Aug 27, 2025); tiny audience; 5% CTC |

Sources for E/F mechanics: TestFlight overview (https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview, acc.);
EU terms from Oct 1, 2026 (https://developer.apple.com/news/?id=gmws0jgp; https://developer.apple.com/support/dma-and-apps-in-the-eu/, acc.);
AltStore PAL (https://faq.altstore.io/developers/distribute-with-altstore-pal, acc.); Japan MSCA
(https://developer.apple.com/news/?id=074b3wzz; https://developer.apple.com/support/app-distribution-in-japan/, acc.).

## 7. Developer identity and the EU (DSA)

- An individual developer's **legal name is the seller name** on the store
  (https://developer.apple.com/programs/enroll/, acc.).
- EU storefronts: a **trader** (monetized app) must publish address, phone and email on the product
  page; apps without a declared status were removed Feb 17–18, 2025 (~135k)
  (https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/;
  https://techcrunch.com/2025/02/18/apple-purges-apps-without-contact-info-from-eu-app-store-as-dsa-deadline-hits).
- Options: PO box/virtual office (with proof of association), an LLC (needs a D-U-N-S number; DBAs are not
  accepted), or excluding EU storefronts. Combined with subpoena risk (section 2), **never ship a
  source-aggregator under your personal name** if you ship one at all.

## 8. Recommendation

- **Personal:** build the `personal` flavor, distribute to yourself via TestFlight internal testing.
  Low risk, keeps v1's sources, gives you the native shell, background narration and CarPlay audio.
- **Public (only if you decide to go ahead):** ship approach **D** under a neutral brand: a polished
  reader + on-device narrator for EPUB/TXT/OPDS/public-domain and explicitly permitted sources, free with
  light ads and Pro. Keep the declarative source engine in the codebase but expose user-added sources
  only after deciding to build the 4.7 controls (or never, in the store build).
- **Do not** submit A, B or C from the same developer account that hosts your personal build.
