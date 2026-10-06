/**
 * Revenue model for docs/monetization.md (ads + Pro via monthly/annual subscription OR lifetime).
 * Every number is an ASSUMPTION documented in the doc; change them here and re-run:
 *   node tools/revenue-model.ts            → markdown tables
 * Simulates 24 months with constant DAU and constant monthly Pro conversion; reports month 12 and 24.
 */

export interface AdAssumptions {
  usShare: number;
  rowFactor: number; // rest-of-world eCPM as a fraction of US
  ecpm: { interstitial: number; rewarded: number; banner: number }; // US, USD per 1000
  perDau: { interstitial: number; rewarded: number; banner: number }; // impressions per ad-seeing DAU per day
  fill: number;
}

export interface Pricing {
  name: string;
  monthly: number;
  annual: number | null;
  lifetime: number;
  /** ASSUMPTION: conversion relative to pricing C (cheaper converts more). No published elasticity data for this category. */
  conversionFactor: number;
  /** ASSUMPTION: plan mix override for this price ladder (a cheap lifetime relative to monthly pulls buyers to lifetime). */
  mix?: { monthly: number; annual: number; lifetime: number };
}

export interface ProAssumptions {
  newBuyersPerMonthOfDau: number; // new Pro purchases per month as a fraction of DAU
  mix: { monthly: number; annual: number; lifetime: number }; // of new buyers (re-normalized when a plan is missing)
  monthlyChurn: number; // monthly subscriber churn
  annualRenewal: number; // share of annual subscribers who renew
  payerAppChurn: number; // monthly rate at which lifetime buyers stop using the app (leave DAU)
}

export const APPLE_CUT = 0.15; // App Store Small Business Program (and subscriptions)
export const FIXED_COSTS_PER_MONTH = (99 + 10.46) / 12; // Apple Developer Program + .com domain

export const ADS: Record<'low' | 'base' | 'high', AdAssumptions> = {
  low: { usShare: 0.25, rowFactor: 0.3, ecpm: { interstitial: 5, rewarded: 8, banner: 0.3 }, perDau: { interstitial: 0.3, rewarded: 0.05, banner: 2 }, fill: 0.85 },
  base: { usShare: 0.4, rowFactor: 0.4, ecpm: { interstitial: 9, rewarded: 12, banner: 0.5 }, perDau: { interstitial: 0.6, rewarded: 0.15, banner: 4 }, fill: 0.9 },
  high: { usShare: 0.55, rowFactor: 0.5, ecpm: { interstitial: 14, rewarded: 18, banner: 0.9 }, perDau: { interstitial: 1.0, rewarded: 0.3, banner: 8 }, fill: 0.95 },
};

export const PRO: Record<'low' | 'base' | 'high', ProAssumptions> = {
  low: { newBuyersPerMonthOfDau: 0.003, mix: { monthly: 0.25, annual: 0.25, lifetime: 0.5 }, monthlyChurn: 0.16, annualRenewal: 0.35, payerAppChurn: 0.06 },
  base: { newBuyersPerMonthOfDau: 0.008, mix: { monthly: 0.2, annual: 0.25, lifetime: 0.55 }, monthlyChurn: 0.137, annualRenewal: 0.44, payerAppChurn: 0.04 },
  high: { newBuyersPerMonthOfDau: 0.015, mix: { monthly: 0.15, annual: 0.3, lifetime: 0.55 }, monthlyChurn: 0.11, annualRenewal: 0.5, payerAppChurn: 0.03 },
};

export const PRICINGS: Pricing[] = [
  { name: 'A: Tachimanga-like ($1.99 / $9.99 yr / $24.99)', monthly: 1.99, annual: 9.99, lifetime: 24.99, conversionFactor: 1.15 },
  // Lifetime = 5 months of the subscription: most buyers take lifetime.
  { name: 'B: as proposed ($4.99 / no annual / $24.99)', monthly: 4.99, annual: null, lifetime: 24.99, conversionFactor: 0.9, mix: { monthly: 0.2, annual: 0, lifetime: 0.8 } },
  { name: 'C: recommended ($2.99 / $17.99 yr / $29.99)', monthly: 2.99, annual: 17.99, lifetime: 29.99, conversionFactor: 1 },
];

/** Ad revenue per ad-seeing DAU per day (USD). */
export function adRevenuePerDau(a: AdAssumptions): number {
  const geo = a.usShare + (1 - a.usShare) * a.rowFactor;
  const perImpression = (ecpm: number): number => (ecpm / 1000) * geo * a.fill;
  return a.perDau.interstitial * perImpression(a.ecpm.interstitial) + a.perDau.rewarded * perImpression(a.ecpm.rewarded) + a.perDau.banner * perImpression(a.ecpm.banner);
}

export interface MonthResult {
  month: number;
  ads: number;
  iap: number;
  proShare: number;
  total: number;
}

/** Net (after Apple) expected lifetime value of one buyer of each plan. */
export function ltv(p: Pricing, pro: ProAssumptions): { monthly: number; annual: number | null; lifetime: number } {
  const net = 1 - APPLE_CUT;
  return {
    monthly: (p.monthly * net) / pro.monthlyChurn,
    annual: p.annual === null ? null : (p.annual * net) / (1 - pro.annualRenewal),
    lifetime: p.lifetime * net,
  };
}

export function simulate(dau: number, ads: AdAssumptions, pro: ProAssumptions, price: Pricing, months = 24): MonthResult[] {
  const mix = { ...(price.mix ?? pro.mix) };
  if (price.annual === null && mix.annual > 0) {
    const t = mix.monthly + mix.lifetime;
    mix.monthly = (mix.monthly + mix.annual * (mix.monthly / t)) as number;
    mix.lifetime = 1 - mix.monthly;
    mix.annual = 0;
  }
  const net = 1 - APPLE_CUT;
  let monthlySubs = 0;
  const annualCohorts: number[] = []; // active annual subscribers by start month
  let lifetimeActive = 0;
  const perDau = adRevenuePerDau(ads);
  const out: MonthResult[] = [];
  for (let m = 1; m <= months; m++) {
    const buyers = dau * pro.newBuyersPerMonthOfDau * price.conversionFactor;
    let iap = 0;
    // monthly: existing subs renew (after churn), new ones pay first month
    monthlySubs = monthlySubs * (1 - pro.monthlyChurn) + buyers * mix.monthly;
    iap += monthlySubs * price.monthly * net;
    // annual: new cohort pays now; cohorts renew every 12 months
    annualCohorts.push(buyers * mix.annual);
    for (let i = 0; i < annualCohorts.length; i++) {
      const age = annualCohorts.length - 1 - i;
      if (age > 0 && age % 12 === 0) annualCohorts[i] = (annualCohorts[i] as number) * pro.annualRenewal;
      if (age % 12 === 0 && price.annual !== null) iap += (annualCohorts[i] as number) * price.annual * net;
    }
    // lifetime: one payment
    iap += buyers * mix.lifetime * price.lifetime * net;
    lifetimeActive = lifetimeActive * (1 - pro.payerAppChurn) + buyers * mix.lifetime;
    const proUsers = monthlySubs + annualCohorts.reduce((a, b) => a + b, 0) + lifetimeActive;
    const proShare = Math.min(1, proUsers / dau);
    const adsRev = dau * (1 - proShare) * perDau * 30.4;
    out.push({ month: m, ads: adsRev, iap, proShare, total: adsRev + iap });
  }
  return out;
}

const fmt = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

if (import.meta.main) {
  console.log('### Ad revenue per ad-seeing DAU per day');
  for (const k of ['low', 'base', 'high'] as const) console.log(`- ${k}: $${adRevenuePerDau(ADS[k]).toFixed(4)}`);
  console.log('\n### Net LTV per buyer (after 15% Apple), base churn');
  console.log('| Pricing | Monthly sub | Annual sub | Lifetime | Lifetime ÷ best sub LTV |\n|---|---|---|---|---|');
  for (const p of PRICINGS) {
    const l = ltv(p, PRO.base);
    const best = Math.max(l.monthly, l.annual ?? 0);
    console.log(`| ${p.name} | ${fmt(l.monthly)} | ${l.annual === null ? '—' : fmt(l.annual)} | ${fmt(l.lifetime)} | ${(l.lifetime / best).toFixed(2)} |`);
  }
  for (const p of PRICINGS) {
    console.log(`\n### ${p.name}: monthly revenue (ads + Pro, after Apple's 15%) at month 12 / month 24`);
    console.log('| DAU | Low | Base | High |\n|---|---|---|---|');
    for (const dau of [1_000, 10_000, 50_000]) {
      const cells = (['low', 'base', 'high'] as const).map((k) => {
        const r = simulate(dau, ADS[k], PRO[k], p);
        const m12 = r[11] as MonthResult;
        const m24 = r[23] as MonthResult;
        return `${fmt(m12.total)} / ${fmt(m24.total)} (ads ${fmt(m12.ads)}, Pro ${fmt(m12.iap)}, Pro users ${(m12.proShare * 100).toFixed(1)}%)`;
      });
      console.log(`| ${dau.toLocaleString('en-US')} | ${cells.join(' | ')} |`);
    }
  }
  console.log(`\nFixed costs: ${fmt(FIXED_COSTS_PER_MONTH)}/month (Apple $99/yr + domain $10.46/yr).`);
  for (const k of ['low', 'base'] as const) {
    let dau = 10;
    while (dau < 100_000 && (simulate(dau, ADS[k], PRO[k], PRICINGS[2] as Pricing)[11] as MonthResult).total < FIXED_COSTS_PER_MONTH) dau += 5;
    console.log(`Break-even (pricing C, ${k}, month 12): ~${dau} DAU`);
  }
}
