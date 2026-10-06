# Monetization plan — TachiNovel v2

Status: research + model, 2026-10-06. General information, not financial, tax or legal advice. Sources
carry dates; "acc." = accessed 2026-10-06. Numbers marked **assumption** are mine; the revenue model is
code (`node tools/revenue-model.ts`) so you can change any assumption and re-run.

## Bottom line

1. **Fix the content model first** (docs/app-store-risk.md). Ads and a paid tier on scraped third-party
   content is what gets apps removed, and AdMob can also disable ad serving without warning for
   copyright problems (https://support.google.com/admob/answer/6128543, acc.). Everything below assumes
   the store build of approach D (owned/licensed/public-domain/permitted content + TTS).
2. **Hybrid works and fits your instinct:** ads in the free tier, removable by a subscription **or** a
   lifetime purchase (Tachimanga does exactly this: $1.99/mo, $9.99/yr, $24.99–29.99 lifetime,
   https://apps.apple.com/us/app/tachimanga/id6447486175, acc.).
3. **Pro's real pull is on-device HD narration**, not ad removal. Narration itself (system voices,
   lock screen, CarPlay audio) stays free: it is the funnel, gating it while people drive is a safety
   and goodwill problem, and comparable apps keep background audio free.
4. **Recommended ladder (C): $2.99/month, $17.99/year (7-day trial), $29.99 lifetime.** Your proposal
   ($4.99/month, $24.99 lifetime, no annual) makes lifetime cost 5 months of subscription, so ~80% of
   buyers pick lifetime and the subscription becomes a decoy. Modelled revenue differs by only ~±10%
   between ladders; **DAU decides everything** (50× between scenarios).
5. **Expect little money without marketing.** Indie reality is tens to hundreds of DAU → roughly
   $10–$100/month. That covers the $99/year, not a salary. 10k+ DAU needs ~30k+ installs a month.

## 1. Free vs Pro — where the paywall goes

Scores: **Annoyance** = how much free users mind if gated (1 low – 5 high). **Pull** = how much it makes
engaged users pay (1–5). **Risk** = App Store/IP/policy risk of gating it. Evidence in section 3.

| Lever | Annoyance if gated | Pull | Risk | Cost to us | Verdict |
|---|---|---|---|---|---|
| Ad-free (all formats) | — | 4 | low | none | **Pro** (the classic lever; Tachimanga, Overcast, Moon+ Pro) |
| On-device **HD neural voices** (Kokoro) | 2 if metered | **5** | low | download size only (on-device, zero marginal cost) | **Pro, metered free taste**: 30 min/day free, +60 min per rewarded ad (max 3/day) |
| Narration with system voices, lock screen, CarPlay audio | 5 | 3 | medium (2.5.4 optics; safety: screen-on while driving) | none | **Free** — the funnel into HD voices |
| Narration extras: sleep timer, speed > 2×, pronunciation lexicon editor | 2 | 2 | low | none | **Pro** (lexicon) / free (sleep timer) |
| Offline downloads | 3 | 3 | **high** (5.2.3; "monetizes access" to third-party content) | none | **Free and capped for everyone**, never a paywall lever; Royal Road sells exactly this |
| Smart auto-download ("keep next N chapters") | 2 | 2 | medium (same reason) | none | Free in store build; revisit only for owned content |
| Number of sources / repos | 5 | 3 | **very high** (charging for access to third-party content) | none | **Never gate** |
| Categories (unlimited) | 4 | 1 | low | none | Free (organising is core; gating feels petty) |
| Backup / restore | 5 | 1 | low | none | Free (data safety) |
| iCloud sync across devices | 2 | 2 | low | none (user's iCloud) | Free (it is v1's storage design; gating it would need a second storage path) |
| Reading insights / stats | 1 | 2 | low | none | **Pro** (Overcast gates stats) |
| Extra reader themes, custom colours, extra fonts | 1 | 2 | low | none | **Pro** (basic Light/Sepia/Dark/Black stay free — accessibility) |
| Text-cleanup rules | 1 | 1 | low | none | **Pro** beyond 3 rules |
| Home-screen widget | 1 | 1 | low | none | **Pro** |
| New-chapter notifications / background update checks | 3 | 1 | low | none | **Free** (drives retention → ad impressions; Tachimanga gating auto-update draws complaints) |
| App lock (Face ID) | 4 | 1 | low | none | **Free** (Tachimanga gating it drew a 2024-08-19 review complaint) |
| Cloud voices / AI translation (future) | — | 4 | medium (5.1.2(i) third-party AI) | **$4–$80 per 1M characters** | Subscription only, never lifetime (section 6) |

**The sweet spot.** Free users get the whole reader, every source, narration with system voices on the
lock screen and in the car, and a daily taste of HD voices — the funnel stays wide and the app is
genuinely good for free. Engaged users hit three nudges: ads between browse sessions, the HD-voice
meter running out mid-commute, and the "extras" bundle (stats, themes, widget, lexicon). Pro removes all
of it at once; one tier, no confusing feature matrix. The code mirrors this table:
`src/ui/monetization/entitlements.ts` (FEATURES) and `src/ui/monetization/ad-policy.ts`.

**Paywall moments (soft, never blocking reading):** when the daily HD-voice minutes run out (offer
rewarded ad or Pro), after the 2nd interstitial of a day ("Remove ads"), in the voice picker (HD voices
badge), and in More → "TachiNovel Pro". Never on launch, never mid-chapter.

## 2. Ads

### SDK choice
| SDK / plugin | Status (acc. 2026-10-06) | Verdict |
|---|---|---|
| **@capacitor-community/admob** | v8.2.0, Oct 5, 2026; Capacitor 8.5+, iOS 15+; banner, interstitial, rewarded, rewarded interstitial, app open; UMP consent + ATT helpers (https://api.github.com/repos/capacitor-community/admob/releases ; https://github.com/capacitor-community/admob) | **Use this.** Wired in `src/ui/monetization/ads.ts` (compiled in only with `--ads`) |
| @capgo/capacitor-admob | v8.1.19, Sept 22, 2026, 14 stars (https://api.github.com/repos/Cap-go/capacitor-admob) | Backup option |
| AppLovin MAX | No Capacitor plugin; official Cordova plugin 2.1.0 (Apr 5, 2025) lags native SDK 13.6.4 (Aug 11, 2026) by ~16 months (https://api.github.com/repos/AppLovin/AppLovin-MAX-Cordova/releases ; https://api.github.com/repos/AppLovin/AppLovin-MAX-SDK-iOS/releases) | Not now; add as AdMob **mediation** partner later if DAU justifies |
| Unity LevelPlay | Only a 0-star community plugin (0.1.42, May 29, 2026; https://registry.npmjs.org/capacitor-levelplay-ads) | Avoid |
| Meta Audience Network | Via AdMob mediation adapter (https://developers.google.com/admob/ios/mediation/meta) | Later, via mediation |

Google Mobile Ads ships its own privacy manifest since SDK 11.2.0
(https://developers.google.com/admob/ios/privacy/data-disclosure, acc.). Capacitor is on Apple's
"commonly used SDKs" list, so the app needs a privacy manifest (done: ios/App/App/PrivacyInfo.xcprivacy;
https://developer.apple.com/support/third-party-SDK-requirements/, acc.).

### Compliance checklist (ads build)
- **Consent (EEA/UK/CH):** Google-certified, TCF-integrated CMP required (EEA/UK since Jan 16, 2024; CH
  since July 31, 2024) — use Google's UMP; request consent info every launch, gate on `canRequestAds`,
  give a "Privacy options" entry in Settings (https://support.google.com/admob/answer/13554020 ;
  https://developers.google.com/admob/ios/privacy, acc.). US states: AdMob's "Do Not Sell or Share"
  message (https://support.google.com/admob/answer/10862202, acc.).
- **ATT:** ask only after an explainer, never with incentives, never gating features (5.1.2(i);
  https://developer.apple.com/app-store/user-privacy-and-data-use/, acc.). Our flow asks from the 2nd
  session. Expect low opt-in: industry 35–38%, "publications" category **18–26%** (Adjust 2026 via
  https://ppc.land/adjusts-2026-mobile-app-report-finance-sessions-up-21-gaming-cpi-jumps-30/, Feb 22, 2026;
  AppsFlyer 50% global, https://www.appsflyer.com/company/newsroom/pr/post-att-growth/, Apr 24, 2025).
  EU alternative ATT prompt from iOS 27.2 (https://developer.apple.com/news/?id=idsft9ai, Sept 16, 2026).
- **Info.plist (ads build only):** `GADApplicationIdentifier`, `SKAdNetworkItems` (Google's list,
  https://developers.google.com/admob/ios/3p-skadnetworks), `NSUserTrackingUsageDescription`.
- **Privacy label:** declare what AdMob collects — IP address/coarse location, crash and performance
  data, device ID, advertising data, product interaction; purposes third-party advertising + analytics
  (https://developers.google.com/admob/ios/privacy/data-disclosure ;
  https://developer.apple.com/app-store/app-privacy-details/, acc.).
- **2.5.18:** age-appropriate ads (set a conservative max ad content rating), visible close buttons, a
  "Report an ad" path. **app-ads.txt** on your domain (needed to pass AdMob app readiness,
  https://support.google.com/admob/answer/14538460, acc.).
- **Account safety:** test ads until release; never click your own ads; invalid-traffic suspensions are
  ~30 days and not appealable (https://support.google.com/admob/troubleshooter/12205649 ;
  https://www.blog.google/products/admob/understanding-account-suspensions-due-invalid-traffic, 2017-03-03).
  Payout threshold $100 (https://support.google.com/admob/answer/2772208, acc.).

### Placement design (implemented: `AdPolicy`, unit-tested)
- **Interstitial only at a browse → novel transition**: after ≥3 browse/search calls in a burst, at most
  one per 3 novel opens, ≥12 min apart, ≤4 per day. Never in the first session, never within 3 min of
  reading (chapter.get/progress.save), **never while narration is playing or paused**, never on launch,
  exit or back navigation. (Google: no interstitials on launch/exit, never two in a row,
  https://support.google.com/admob/answer/6066980, acc.)
- **Rewarded (opt-in only):** "+60 minutes of HD voice", max 3/day. The only rewarded placement.
- **Banner:** browse/search result screens only, never in the reader or library (needs a small v1 UI
  slot; not wired yet).
- **No app-open ads.** They are the most hated format in reading apps' reviews (Tachimanga's reviews
  complain about ads at launch).
- **Pro = zero ads**, including the rewarded prompts. During a free trial: zero ads. After a
  subscription lapses: ads return after Apple's billing grace period ends.

## 3. What comparable apps charge (acc. 2026-10-06)

| App | Free tier | Paid | Price | What's gated |
|---|---|---|---|---|
| Tachimanga | ads at launch | Premium | $1.99/mo, $9.99/yr, $24.99–29.99 lifetime | ad removal, colour customisation, auto-update, Face ID lock (criticised) |
| Paperback | everything | — | free, no ads | nothing |
| Aidoku / Mihon / LNReader | everything | donations | free | nothing |
| Royal Road (official) | ads | Premium | $3.49/mo | ad-free + offline downloads |
| KyBook 3 | reading + TTS | Pro + sync | $4.99 once; sync $14.99/yr | sync as the subscription |
| Voice Dream | system voices, background audio | subscription | $4.99/mo; $39.99–89.99/yr | 200+ premium voices; Dec 2023 paid→subscription switch drew angry reviews |
| Speechify | word-limited basic TTS | Premium | $11.99–24.99/mo; $139.99–159.99/yr | HD voices, speed, limits (limits criticised) |
| NaturalReader | basic TTS | Premium/Plus/Pro | $9.99–25.90/mo | AI voices, cloning, MP3 |
| Pocket Casts | free | Plus/Patron | $3.99/mo, $39.99/yr | extras |
| Overcast | free with house ads | Premium | $19.99–29.99 (period unverified) | ad removal, stats, audio effects |
| Sandbook (Kokoro on-device) | free | — | free | — |
| Voice Forge (Kokoro) | — | subscription | $4.99/week … $49.99 lifetime | everything |

Sources: App Store pages — Tachimanga id6447486175, Paperback id1626613373, Royal Road id6456945333,
KyBook id1348198785, Voice Dream id496177674, Speechify id1209815023, NaturalReader id1487572960,
Pocket Casts id414834813, Overcast id888422857, Sandbook id6745732885, Voice Forge id6743238823;
https://aidoku.app/ ; https://mihon.app/ ; https://www.lnreader.app/ ; https://tachimanga.app/help/faq/ (all acc.).

**Read-out:** the reader audience is used to free (Paperback/Mihon) or cheap (Tachimanga $1.99).
$4.99/month is TTS-app pricing (Voice Dream), defensible only because HD voices are in Pro.

## 4. Price ladder, lifetime vs subscription

### Net value of one buyer (after Apple's 15%; base churn)
Monthly churn 13.7%/month (≈17% of monthly subscribers left after a year; annual renewal 44% —
RevenueCat 2025, https://www.revenuecat.com/state-of-subscription-apps-2025/).

| Ladder | Monthly sub LTV | Annual sub LTV | Lifetime | Lifetime ÷ best sub LTV |
|---|---|---|---|---|
| A: Tachimanga-like ($1.99 / $9.99 yr / $24.99) | $12 | $15 | $21 | 1.40 |
| B: as proposed ($4.99 / — / $24.99) | $31 | — | $21 | **0.69** |
| C: recommended ($2.99 / $17.99 yr / $29.99) | $19 | $27 | $25 | 0.93 |

### Cannibalization math
Let `f` = share of buyers who pick lifetime, `S` = net LTV of a subscriber, `L` = net lifetime price,
and `u` = extra buyers that only exist because lifetime is offered (people who refuse subscriptions).
Offering lifetime pays off when `(1 + u) · ((1 − f) · S + f · L) ≥ S`.
- Ladder B: S = $31, L = $21, f ≈ 0.8 → lifetime must bring **≥ 34% more buyers** just to break even.
- Ladder C: S ≈ $25 (blend), L = $25 → break-even at u ≈ 0: lifetime costs nothing and catches the
  subscription-averse reader audience (Voice Dream backlash; Paperback praised for "no IAP").
- Lifetime is safe **because HD voices run on device** (no per-user cost). Never sell cloud voices or AI
  features as lifetime: one listener on Azure Neural costs ~$4.95/month (section 6).
- RevenueCat's guidance: lifetime prices range 2–12× annual; too much lifetime revenue hurts recurring
  growth (https://www.revenuecat.com/blog/growth/lifetime-subscriptions/, Nov 2025). 23.2% of apps
  combine subscriptions with lifetime (https://www.revenuecat.com/state-of-subscription-apps, Mar 2026).

### Recommendation
- **C: $2.99/month, $17.99/year with a 7-day free trial, $29.99 lifetime** (launch promo: $24.99
  lifetime for the first month via a scheduled price change, if you like your original number; non-consumables have no introductory offers).
- Trial on the annual plan only: trial-to-paid medians are 37.4% for 5–9-day trials and 42.5% for
  17–32-day trials (RevenueCat 2026); keep it short so the HD-voice meter, not the trial, does the selling.
- Enable **Family Sharing** for the lifetime purchase (goodwill; note it can't be turned off for
  subscriptions once enabled — https://developer.apple.com/app-store/subscriptions/, acc.).
- Use **offer codes** (all IAP types since Oct 29, 2025) for reviewers/friends and **win-back offers**
  for lapsed subscribers (https://developer.apple.com/app-store/subscriptions/ ; developer news, acc.).
- Paywall screen rules: renewal price most prominent, trial length and post-trial price, restore,
  Terms + Privacy links (3.1.2; same Apple page).

## 5. Implementation

- **StoreKit 2, no server** (implemented): `ios/App/App/Native/Store/StorePlugin.swift` + JS API in
  `src/ui/monetization/entitlements.ts`. Pro = verified non-revoked lifetime OR active subscription from
  `Transaction.currentEntitlements`; `Transaction.updates` for renewals/refunds/Ask to Buy; explicit
  Restore button calls `AppStore.sync()`; manage-subscriptions and offer-code sheets.
- App Store Connect: subscription group "Pro" with `<bundle>.pro.monthly` and `.pro.annual`; non-
  consumable `<bundle>.pro.lifetime`; a StoreKit Configuration file for local/CI tests.
- **RevenueCat** (@revenuecat/purchases-capacitor 13.7.0, Oct 1, 2026) is free up to $2,500 monthly
  tracked revenue, then 1% (https://www.revenuecat.com/pricing/, acc.). Add it when you want paywall A/B
  tests, cohort analytics or a web paywall; not needed to launch.
- Small Business Program: 15% instead of 30% under $1M/year — **you must enroll**; the rate starts 15
  days after the fiscal month of approval (https://developer.apple.com/app-store/small-business-program/, acc.).
- US external purchase links: allowed, but Apple asked the court on Aug 14, 2026 for 15% (5% for
  small-business members) on linked purchases; undecided
  (https://www.iclarified.com/101778/apple-seeks-court-approval-for-15-commission-on-external-app-purchases).
  Not worth Stripe + web checkout + entitlement sync for a small app.

## 6. Revenue scenarios

### Assumptions (all **assumptions**, anchored on sources)
| | Low | Base | High | Anchor |
|---|---|---|---|---|
| US share of users / RoW eCPM vs US | 25% / 0.30 | 40% / 0.40 | 55% / 0.50 | — |
| US eCPM interstitial / rewarded / banner | $5 / $8 / $0.30 | $9 / $12 / $0.50 | $14 / $18 / $0.90 | Appodeal Q4 2024 iOS US $14.32 / $19.63 / $0.45 (https://adapty.io/blog/mobile-interstitial-ads/, Feb 15, 2026); Mistplay $13.60 / $13.90 / $0.35 (https://business.mistplay.com/resources/mobile-ads-ecpm/, Mar 13, 2026); discounted because benchmarks are game-heavy and our ATT opt-in will be low |
| Impressions per ad-seeing DAU/day: interstitial / rewarded / banner | 0.3 / 0.05 / 2 | 0.6 / 0.15 / 4 | 1.0 / 0.3 / 8 | Our AdPolicy caps (≤4/day, 12-min gap, browse-only) |
| Fill | 85% | 90% | 95% | — |
| New Pro buyers per month (% of DAU) | 0.3% | 0.8% | 1.5% | Download-to-paid median 2.0% (NA 2.8%), RevenueCat 2026 |
| Plan mix monthly / annual / lifetime | 25/25/50 | 20/25/55 | 15/30/55 | Reader audience is subscription-averse |
| Monthly churn / annual renewal | 16% / 35% | 13.7% / 44% | 11% / 50% | RevenueCat 2025 |
| Price-conversion factor A / B / C | 1.15 / 0.9 / 1.0 | | | No published elasticity data |

Ad revenue per ad-seeing DAU per day: **$0.0010 / $0.0053 / $0.0196** (low/base/high).

### Monthly revenue after Apple's cut, month 12 / month 24 (`node tools/revenue-model.ts`)

**Ladder C (recommended: $2.99 / $17.99 yr / $29.99)**
| DAU | Low | Base | High |
|---|---|---|---|
| 1,000 | $90 / $95 (ads $30, Pro $60) | $316 / $328 (ads $149, Pro $167) | $822 / $813 (ads $504, Pro $318) |
| 10,000 | $900 / $950 | $3,162 / $3,277 | $8,222 / $8,131 |
| 50,000 | $4,501 / $4,751 | $15,808 / $16,383 | $41,109 / $40,657 |

**Ladder B (as proposed: $4.99 / — / $24.99)**: 1k DAU $88 / $310 / $827; 10k $884 / $3,100 / $8,265;
50k $4,422 / $15,502 / $41,327 (month 12, low/base/high).
**Ladder A (Tachimanga-like)**: 1k $82 / $293 / $766; 10k $817 / $2,928 / $7,656; 50k $4,086 / $14,641 / $38,282.

Pro users reach 2.6% / 7.6% / 15.4% of DAU by month 12 (ladder C) and see no ads, which the model
subtracts from ad inventory. For comparison, a one-time "remove ads" purchase alone ($2.99–$4.99)
models at roughly $59 / $281 / $867 per month at 1k DAU (research agent's Model 1, same anchors).

**What this says:** price ladders differ by ~±10%; DAU moves revenue 50×; at base assumptions ads and
Pro contribute about equally. The upside lever is the HD-voice pull (conversion), not ad tuning.

### Realistic expectations
- Most new apps never get there: only 17.3% of new apps reach $1k MRR within 2 years; median year-1
  revenue ≈ $72/month (https://www.revenuecat.com/sosa-26-insights/, 2026); Adapty's median app earns
  $492/month (https://adapty.io/state-of-in-app-subscriptions/, 2026).
- Retention for Books apps: D1 ≈ 22%, D30 ≈ 7.7% (AppsFlyer data via
  https://www.appypie.com/blog/app-categories-with-highest-retention, 2026-09-11; dated data). DAU ≈
  0.2–0.33 × monthly installs (**assumption**). A no-marketing indie reader: 20–500 DAU in year 1.

## 7. Costs and break-even

| Item | Cost | Source |
|---|---|---|
| Apple Developer Program | $99/year | https://developer.apple.com/programs/enroll/ (acc.) |
| Domain (privacy policy, app-ads.txt, support page) | ~$10.46/year (.com at Cloudflare) | https://domainoffer.net/tld/com/cloudflare (acc.) |
| HD voice model hosting | $0 (Apple-hosted asset packs, 200 GB/app included) | docs/tts-v2.md |
| RevenueCat | $0 under $2,500/month | above |
| Google Play (only if Android) | $25 once + 12 testers for 14 days for new personal accounts | https://support.google.com/googleplay/android-developer/answer/14151465 (acc.) |
| LLC (optional) | Wyoming $100 + $60/yr; Delaware $110 + $400/yr; California $800/yr minimum tax | https://sos.wyo.gov/business/docs/businessfees.pdf ; https://corp.delaware.gov/alt-entitytaxinstructions/ ; https://www.ftb.ca.gov/forms/2025/2025-3522.pdf (acc.) |

**Cloud TTS for comparison** (one 2,000-word chapter ≈ 11,000 characters): Google Standard $4/1M chars
→ $0.044; Azure Neural $15 → $0.165; OpenAI tts-1 $15; Google Chirp 3 HD / OpenAI tts-1-hd $30 → $0.33;
ElevenLabs Flash $40 → $0.44, v2/v3 $80 → $0.88 per chapter (https://prices.azure.com/api/retail/prices ;
https://developers.openai.com/api/docs/pricing ; https://elevenlabs.io/pricing/api ;
https://costbench.com/software/voice-apis/google-tts-api/, acc.). One listener at a chapter a day on
Azure Neural ≈ $4.95/month — the whole subscription price. **On-device TTS is what makes this business
possible at all.**

**Break-even:** fixed costs ≈ $9/month → ~30 DAU (base) to ~105 DAU (low) at ladder C. With a
California LLC (+$800/yr) ≈ 300–1,000 DAU.

## 8. Legal and business basics for a solo developer

- **Enrollment:** as an individual, your legal name is the seller name. An organization (LLC) needs a
  D-U-N-S number (free, ~5 business days + 2 for Apple), a legal entity, domain email and website;
  DBAs/sole proprietorships enroll as individuals (https://developer.apple.com/programs/enroll/ ;
  https://developer.apple.com/help/account/membership/D-U-N-S/, acc.).
- **LLC or not:** liability shield + a seller name that isn't yours (useful with DSA and subpoena
  exposure, docs/app-store-risk.md). Wyoming is cheapest but you likely must also register in your home
  state; California charges $800/year regardless. For approach D with tiny revenue, starting as an
  individual is reasonable; for anything aggregating third-party content, don't do it under your name.
- **Tax forms in App Store Connect:** US persons **W-9**; non-US individuals **W-8BEN**, entities
  **W-8BEN-E**; can't be edited after submission
  (https://developer.apple.com/help/app-store-connect/manage-tax-information/provide-tax-information, acc.).
- **Getting paid:** Paid Apps Agreement + bank + tax; Apple pays within 45 days of fiscal month end
  (https://developer.apple.com/help/app-store-connect/getting-paid/overview-of-receiving-payments, acc.).
  Apple acts as your agent and handles VAT/sales tax in most storefronts (general knowledge, not
  re-verified here).
- **US income reporting:** Apple issues Form 1099-K; the IRS says the threshold reverted to $20,000 and
  200 transactions (https://www.irs.gov/newsroom/irs-issues-faqs-on-form-1099-k-threshold-under-the-one-big-beautiful-bill-dollar-limit-reverts-to-20000,
  Oct 23, 2025; Apple's page still says $5,000). All income is taxable regardless. Self-employment tax
  15.3% on net SE earnings ≥ $400, quarterly estimates
  (https://www.irs.gov/businesses/small-businesses-self-employed/self-employment-tax-social-security-and-medicare-taxes).
  AdMob pays separately (Google tax forms, $100 threshold).
- **EU DSA trader status:** monetized → trader → address (PO box allowed with proof), phone, email shown
  on EU product pages; or exclude EU storefronts (docs/app-store-risk.md §7).
- **Privacy policy** (required, in App Store Connect and in the app) and **terms:** Apple's standard EULA
  applies if you don't supply one (https://www.apple.com/legal/internet-services/itunes/dev/stdeula/).
- **Children:** don't target under-13s; amended COPPA Rule compliance date Apr 22, 2026
  (https://www.kirkland.com/publications/kirkland-alert/2025/04/ftc-publishes-coppa-rule); Utah/Texas/
  Louisiana age-assurance laws expect Apple's Declared Age Range API
  (https://developer.apple.com/support/age-assurance/, acc.) — a small native plugin if you ship.
