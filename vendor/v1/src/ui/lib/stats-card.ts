/**
 * "Reading report" card for Insights: a pure model (unit-tested) and a canvas renderer (1080×1350, the
 * 4:5 size social apps like). Drawing uses only system fonts and plain shapes, so it works offline and
 * under the UI's CSP; the result is a PNG data URL.
 */
import type { ReadingStats } from '../../shared/contracts/domain.ts';
import { plural } from './format.ts';
import { dayKey, formatDuration, goalLabel, goalMet, goalStreak, parseDayKey, weekTotals } from './stats-data.ts';

const MIN = 60_000;

export interface CardModel {
  /** "Week of Oct 4" */
  period: string;
  weekTime: string;
  weekChapters: string;
  streak: { days: number; label: string };
  /** Last 7 days, oldest first: weekday initial, share of the tallest day (0..1), goal met. */
  bars: { day: string; value: number; met: boolean; today: boolean }[];
  topNovel: string | null;
}

const fmtWeekOf = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const fmtNarrow = new Intl.DateTimeFormat('en-US', { weekday: 'narrow' });

export function cardModel(stats: ReadingStats, now: number, goal: number | null = null): CardModel {
  const w = weekTotals(stats.days, now);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  const byDate = new Map(stats.days.map((d) => [d.date, d.ms]));
  const today = dayKey(now);
  const last7: { key: string; ms: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = parseDayKey(today);
    d.setDate(d.getDate() - i);
    const key = dayKey(d.getTime());
    last7.push({ key, ms: byDate.get(key) ?? 0 });
  }
  const max = Math.max(...last7.map((d) => d.ms), 1);
  const streakDays = goal !== null ? goalStreak(stats.days, now, goal).days : stats.streakDays;
  return {
    period: `Week of ${fmtWeekOf.format(start)}`,
    weekTime: w.ms > 0 ? formatDuration(w.ms) : '0 m',
    weekChapters: plural(w.chapters, 'chapter'),
    streak: {
      days: streakDays,
      label: goal !== null ? `${streakDays === 1 ? 'day' : 'days'} at ${goalLabel(Math.round(goal / MIN))} a day` : `${streakDays === 1 ? 'day' : 'days'} in a row`,
    },
    bars: last7.map((d) => ({
      day: fmtNarrow.format(parseDayKey(d.key)),
      value: d.ms / max,
      met: goal !== null && goalMet(d.ms, goal),
      today: d.key === today,
    })),
    topNovel: stats.topNovels[0]?.name ?? null,
  };
}

export const CARD = { width: 1080, height: 1350 } as const;

const FONT = '-apple-system, "SF Pro Display", system-ui, "Segoe UI", sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Text that fits `maxWidth`, shortened with "…" if needed. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Draws the card; returns false if the canvas can't be used (then callers fall back to text). */
export function drawCard(canvas: HTMLCanvasElement, m: CardModel): boolean {
  canvas.width = CARD.width;
  canvas.height = CARD.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const W = CARD.width;
  const pad = 96;

  // Background: deep indigo to periwinkle, with a soft glow.
  const bg = ctx.createLinearGradient(0, 0, W, CARD.height);
  bg.addColorStop(0, '#1d2154');
  bg.addColorStop(1, '#4a58b4');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, CARD.height);
  const glow = ctx.createRadialGradient(W * 0.85, 160, 0, W * 0.85, 160, 520);
  glow.addColorStop(0, 'rgba(168,180,255,0.45)');
  glow.addColorStop(1, 'rgba(168,180,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, CARD.height);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = `600 40px ${FONT}`;
  ctx.fillText('TachiNovel · Reading report', pad, 150);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `400 40px ${FONT}`;
  ctx.fillText(m.period, pad, 206);

  // Headline: time this week.
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 168px ${FONT}`;
  ctx.fillText(fit(ctx, m.weekTime, W - pad * 2), pad, 420);
  ctx.font = `500 52px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(`read this week · ${m.weekChapters}`, pad, 500);

  // Streak pill.
  const pillY = 572;
  ctx.font = `600 46px ${FONT}`;
  const pillText = `🔥 ${m.streak.days} ${m.streak.label}`;
  const pw = Math.min(W - pad * 2, ctx.measureText(pillText).width + 72);
  roundRect(ctx, pad, pillY, pw, 92, 46);
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(fit(ctx, pillText, pw - 72), pad + 36, pillY + 62);

  // Last 7 days.
  const chartTop = 760;
  const chartH = 300;
  const gap = 28;
  const bw = (W - pad * 2 - gap * 6) / 7;
  m.bars.forEach((b, i) => {
    const x = pad + i * (bw + gap);
    const h = b.value > 0 ? Math.max(18, b.value * chartH) : 10;
    roundRect(ctx, x, chartTop + chartH - h, bw, h, 18);
    ctx.fillStyle = b.today ? '#ffffff' : b.value > 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)';
    ctx.fill();
    if (b.met) {
      ctx.beginPath();
      ctx.arc(x + bw / 2, chartTop + chartH - h - 26, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#7ee2a0';
      ctx.fill();
    }
    ctx.fillStyle = b.today ? '#ffffff' : 'rgba(255,255,255,0.6)';
    ctx.font = `${b.today ? 700 : 500} 38px ${FONT}`;
    const tw = ctx.measureText(b.day).width;
    ctx.fillText(b.day, x + (bw - tw) / 2, chartTop + chartH + 62);
  });

  // Most read.
  if (m.topNovel) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `500 38px ${FONT}`;
    ctx.fillText('Most read lately', pad, 1212);
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 52px ${FONT}`;
    ctx.fillText(fit(ctx, m.topNovel, W - pad * 2), pad, 1278);
  }
  return true;
}
