/**
 * Reading Insights (More › Reading Insights, Tachimanga's statistics): a weekly summary, today / this
 * week / streak / total tiles, an optional daily goal (progress ring, goal days marked in the chart,
 * a goal-day streak), an activity bar chart (7 days, 30 days, or a year by month) drawn with plain
 * CSS, and the most-read novels. Data comes from `stats.get`; the goal lives in settings.readingGoal.
 */
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseNovelKey, type ReadingStats } from '../../shared/contracts/domain.ts';
import { bridge, toUiError } from '../bridge/client.ts';
import { BarButton, Button, Chip, Row, Section, Segmented, SelectRow, Stepper } from '../components/controls.tsx';
import { Cover } from '../components/cover.tsx';
import { EmptyState, ErrorState, SkeletonLine } from '../components/feedback.tsx';
import { useAsync, useNow } from '../components/hooks.ts';
import { Icon } from '../components/icon.tsx';
import { Screen } from '../components/screen.tsx';
import { Sheet } from '../components/sheet.tsx';
import {
  bucketAria,
  chartBuckets,
  dayKey,
  durationParts,
  durationSpoken,
  formatDuration,
  GOAL_LIMITS,
  GOAL_PRESETS,
  goalCaption,
  goalLabel,
  goalMet,
  goalProgress,
  goalStreak,
  goalToMs,
  HEAT_DAYS,
  HEAT_WEEKS,
  heatCellLabel,
  heatMonths,
  longestSessionDetail,
  niceScale,
  parseDayKey,
  readLearnedPace,
  rangeFacts,
  rangeTotals,
  streakCaption,
  tickLabel,
  todayTotals,
  weekShareText,
  weekSummary,
  weekTotals,
  weekVsLastWeek,
  wordsEstimate,
  yearGrid,
  type StatsRange,
} from '../lib/stats-data.ts';
import { plural } from '../lib/format.ts';
import { cardModel, CARD, drawCard } from '../lib/stats-card.ts';
import { actionSheet } from '../state/actions.ts';
import { openNovel, popToRoot, selectTab } from '../state/nav.ts';
import { library, patchSettings, settings } from '../state/store.ts';
import { showToast } from '../state/toast.ts';
import '../styles/extras.css';

const RANGES: { value: `${StatsRange}`; label: string }[] = [
  { value: '7', label: '7 Days' },
  { value: '30', label: '30 Days' },
  { value: '365', label: 'Year' },
];

const MIN = 60_000;

/** "1h 26m" set large/small on screen, "1 hour 26 minutes" for screen readers. */
function Duration({ ms }: { ms: number }) {
  return (
    <>
      {durationParts(ms).map((p, i) => (
        <span key={i} class="ins-dur" aria-hidden="true">
          {p.value}
          <small>{p.unit}</small>
        </span>
      ))}
      <span class="sr-only">{durationSpoken(ms)}</span>
    </>
  );
}

function Tile(props: { label: string; value: ComponentChildren; caption: string; testId: string; accent?: boolean; corner?: ComponentChildren }) {
  return (
    <div class={`ins-tile${props.accent ? ' is-accent' : ''}`} data-testid={props.testId}>
      <span class="ins-tile-label">{props.label}</span>
      <span class="ins-tile-value tabular">{props.value}</span>
      <span class="ins-tile-caption">{props.caption}</span>
      {props.corner}
    </div>
  );
}

/** Today's progress toward the daily goal. */
function GoalRing(props: { ms: number; goal: number }) {
  const r = 15.5;
  const c = 2 * Math.PI * r;
  const p = goalProgress(props.ms, props.goal);
  const met = goalMet(props.ms, props.goal);
  const label = `${Math.floor(props.ms / MIN)} of ${Math.round(props.goal / MIN)} minutes${met ? ', goal met' : ''}`;
  return (
    <span class={`ins-ring${met ? ' is-met' : ''}`} role="img" aria-label={label} data-testid="ins-goal-ring">
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle class="ins-ring-track" cx="18" cy="18" r={r} />
        {p > 0 && <circle class="ins-ring-fill" cx="18" cy="18" r={r} stroke-dasharray={`${c * p} ${c}`} transform="rotate(-90 18 18)" />}
      </svg>
      {met && <Icon name="checkmark" size={14} class="ins-ring-check" />}
    </span>
  );
}

function Tiles({ stats, now, goal }: { stats: ReadingStats; now: number; goal: number | null }) {
  const today = todayTotals(stats.days, now);
  const week = weekTotals(stats.days, now);
  const gs = goal !== null ? goalStreak(stats.days, now, goal) : null;
  const streak = gs ? gs.days : stats.streakDays;
  const streakText = gs?.capped ? `${streak}+` : String(streak);
  const streakNote = goal !== null ? (goalMet(today.ms, goal) ? 'Goal met today' : `${goalCaption(today.ms, goal)} today`) : streakCaption(streak, today.ms);
  return (
    <div class="ins-tiles">
      <Tile
        label="Today"
        value={<Duration ms={today.ms} />}
        caption={goal !== null ? goalCaption(today.ms, goal) : plural(today.chapters, 'chapter')}
        corner={goal !== null ? <GoalRing ms={today.ms} goal={goal} /> : undefined}
        testId="ins-today"
      />
      <Tile label="This Week" value={<Duration ms={week.ms} />} caption={plural(week.chapters, 'chapter')} testId="ins-week" />
      <Tile
        label={goal !== null ? 'Goal Streak' : 'Streak'}
        accent={streak > 0}
        value={
          <>
            <span class="ins-dur" aria-hidden="true">
              {streakText}
              <small>{streak === 1 ? 'day' : 'days'}</small>
            </span>
            <span class="sr-only">{`${streakText} ${streak === 1 ? 'day' : 'days'}`}</span>
            {streak > 0 && (
              <span class="ins-flame" aria-hidden="true">
                🔥
              </span>
            )}
          </>
        }
        caption={streakNote}
        testId="ins-streak"
      />
      <Tile label="Total Time" value={<Duration ms={stats.totalMs} />} caption="All time" testId="ins-total" />
    </div>
  );
}

/** The pace the reader learned on this device (localStorage), or null. Never throws. */
function storedPace(): number | null {
  return readLearnedPace(() => window.localStorage);
}

/**
 * All-time records: the longest sitting (when the script knows it; opens that novel) and the reading
 * speed the reader learned on this device. Nothing shows until there's something to show.
 */
function PersonalBests({ stats, now }: { stats: ReadingStats; now: number }) {
  const [wpm] = useState(storedPace);
  const ls = stats.longestSession && stats.longestSession.ms > 0 ? stats.longestSession : null;
  if (!ls && wpm === null) return null;
  const k = ls?.key ? parseNovelKey(ls.key) : null;
  const name = ls?.name?.trim();
  return (
    <Section footer={wpm !== null ? 'Reading speed is learned while you read on this iPhone, from steady reading only.' : undefined}>
      {ls && (
        <Row
          title="Longest Session"
          subtitle={longestSessionDetail(ls, now)}
          value={<span class="tabular">{formatDuration(ls.ms)}</span>}
          icon={{ name: 'book.clock', color: 'var(--indigo)' }}
          {...(k && name ? { onClick: () => openNovel({ pluginId: k.pluginId, path: k.path, name }), chevron: true } : {})}
          testId="ins-longest"
        />
      )}
      {wpm !== null && (
        <Row
          title="Reading Speed"
          subtitle={`${wordsEstimate(stats.totalMs, wpm).replace(/^a/, 'A')} in all, at this pace`}
          value={<span class="tabular">{wpm} words/min</span>}
          icon={{ name: 'bolt.fill', color: 'var(--orange)' }}
          testId="ins-speed"
        />
      )}
    </Section>
  );
}

// ---------- daily goal ----------

function GoalSection({ minutes, onCustom }: { minutes: number | null; onCustom: () => void }) {
  const set = (m: number | null): void => patchSettings({ readingGoal: m === null ? null : { minutesPerDay: m } });
  if (minutes === null) {
    return (
      <Section header="Daily Goal" footer="Days you reach your goal are marked in the chart, and your streak counts goal days.">
        <div class="row ins-goal-pick" data-testid="ins-goal-pick">
          <span class="row-main">
            <span class="row-title">Set a daily goal</span>
          </span>
        </div>
        <div class="ins-goal-chips">
          {GOAL_PRESETS.map((m) => (
            <Chip key={m} onClick={() => set(m)}>
              {goalLabel(m)}
            </Chip>
          ))}
          <Chip onClick={onCustom}>Custom…</Chip>
        </div>
      </Section>
    );
  }
  const options = [
    { value: 'off', label: 'Off' },
    ...[...new Set<number>([...GOAL_PRESETS, minutes])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: goalLabel(m) })),
    { value: 'custom', label: 'Custom…' },
  ];
  return (
    <Section header="Daily Goal" footer="Days you reach your goal are marked in the chart, and your streak counts goal days.">
      <SelectRow
        title="Daily goal"
        value={String(minutes)}
        options={options}
        onChange={(v) => {
          if (v === 'off') set(null);
          else if (v === 'custom') onCustom();
          else set(Number(v));
        }}
        testId="ins-goal"
      />
    </Section>
  );
}

function CustomGoalSheet(props: { open: boolean; initial: number; onClose: () => void }) {
  const [m, setM] = useState(props.initial);
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Daily Goal" detents={['fit']} testId="goal-sheet">
      <div class="ins-goal-sheet">
        <Section footer="Reading time a day, counted while a chapter is open.">
          <div class="row">
            <span class="row-main">
              <span class="row-title">Read every day</span>
            </span>
            <Stepper label="Daily goal" value={m} min={GOAL_LIMITS.min} max={GOAL_LIMITS.max} step={GOAL_LIMITS.step} onChange={setM} format={goalLabel} />
          </div>
        </Section>
      </div>
      <div class="sheet-pad">
        <Button
          variant="filled"
          size="large"
          onClick={() => {
            patchSettings({ readingGoal: { minutesPerDay: m } });
            props.onClose();
          }}
        >
          Set Goal
        </Button>
      </div>
    </Sheet>
  );
}

// ---------- chart ----------

function ActivityChart({ stats, now, busy, goal }: { stats: ReadingStats; now: number; busy: boolean; goal: number | null }) {
  const buckets = chartBuckets(stats.days, now, goal);
  const [selected, setSelected] = useState<string | null>(null);
  const sel = buckets.find((b) => b.key === selected) ?? null;
  const totals = rangeTotals(stats.days);
  const n = stats.days.length;
  const daily = n <= 31;
  const scale = niceScale(Math.max(0, ...buckets.map((b) => b.ms), daily && goal !== null ? goal : 0));
  const avgPct = daily && totals.dailyAverageMs > 0 ? Math.min(100, (totals.dailyAverageMs / scale.max) * 100) : null;
  const goalPct = daily && goal !== null ? Math.min(100, (goal / scale.max) * 100) : null;
  const rangeLong = daily ? `the last ${n} days` : 'the last year';
  const selGoal = sel && goal !== null && sel.goalDays > 0 ? (daily ? ' · goal met' : ` · ${plural(sel.goalDays, 'goal day')}`) : '';

  return (
    <div class={`ins-card${busy ? ' is-busy' : ''}`} data-testid="ins-chart">
      <div class="ins-readout" aria-live="polite">
        {sel ? (
          <>
            <span class="ins-readout-label">{sel.label}</span>
            <span class="ins-readout-value tabular">
              {formatDuration(sel.ms)}
              <span class="ins-readout-sub">
                {' '}
                · {plural(sel.chapters, 'chapter')}
                {selGoal}
              </span>
            </span>
          </>
        ) : (
          <>
            <span class={`ins-readout-label${daily ? ' is-avg' : ''}`}>{daily ? 'Daily average' : 'Total'}</span>
            <span class="ins-readout-value tabular">
              {formatDuration(daily ? totals.dailyAverageMs : totals.ms)}
              <span class="ins-readout-sub"> · {daily ? `${formatDuration(totals.ms)} in ${n} days` : plural(totals.chapters, 'chapter')}</span>
            </span>
          </>
        )}
      </div>
      <div class="ins-plot">
        <div class="ins-grid" aria-hidden="true">
          {scale.ticks.map((t) => {
            const pct = (t / scale.max) * 100;
            // The goal's label takes the gutter where it would overlap a gridline label.
            const hideLabel = goalPct !== null && Math.abs(pct - goalPct) < 12;
            return (
              <div class="ins-gridline" key={t} style={{ bottom: `${pct}%` }}>
                {!hideLabel && <span>{tickLabel(t)}</span>}
              </div>
            );
          })}
          {avgPct !== null && <div class="ins-avgline" style={{ bottom: `${avgPct}%` }} />}
          {goalPct !== null && (
            <div class="ins-goalline" style={{ bottom: `${goalPct}%` }} data-testid="ins-goal-line">
              <span>Goal</span>
            </div>
          )}
        </div>
        <ol class={`ins-bars${buckets.length > 14 ? ' is-dense' : ''}${sel ? ' has-selection' : ''}`} aria-label={`Reading time per ${daily ? 'day' : 'month'}, ${rangeLong}`}>
          {buckets.map((b) => {
            const v = b.ms > 0 ? Math.max(0.025, b.ms / scale.max) : 0;
            const met = daily && b.goalDays > 0;
            return (
              <li class="ins-slot" key={b.key}>
                <button
                  type="button"
                  class={`ins-bar tap${b.current ? ' is-current' : ''}${selected === b.key ? ' is-selected' : ''}${b.ms === 0 ? ' is-empty' : ''}${met ? ' is-goal' : ''}`}
                  aria-label={bucketAria(b, daily)}
                  aria-pressed={selected === b.key}
                  onClick={() => setSelected(selected === b.key ? null : b.key)}
                  data-testid="ins-bar"
                >
                  <span class="ins-bar-fill" style={{ transform: `translate3d(0, ${(1 - v) * 100}%, 0)` }} />
                </button>
                {met && <span class="ins-goal-dot" style={{ bottom: `calc(${Math.min(100, v * 100)}% + 3px)` }} aria-hidden="true" />}
              </li>
            );
          })}
        </ol>
      </div>
      <div class="ins-axis" aria-hidden="true">
        {buckets.map((b) => (
          <span key={b.key} class={b.current ? 'is-current' : ''}>
            {b.axis}
          </span>
        ))}
      </div>
      <RangeFactsRow stats={stats} goal={goal} />
    </div>
  );
}

const fmtBestDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** Days read (or goal days), best day and longest run in the chart's range. */
function RangeFactsRow({ stats, goal }: { stats: ReadingStats; goal: number | null }) {
  const f = rangeFacts(stats.days, goal);
  return (
    <dl class="ins-facts" data-testid="ins-facts">
      <div class="ins-fact">
        <dt>{goal !== null ? 'Goal met' : 'Days read'}</dt>
        <dd class="tabular">
          {goal !== null ? f.goalDays : f.activeDays}
          <small> of {f.days}</small>
        </dd>
      </div>
      <div class="ins-fact">
        <dt>Best day</dt>
        <dd class="tabular">
          {f.best ? (
            <>
              {fmtBestDay.format(parseDayKey(f.best.date))}
              <small> · {formatDuration(f.best.ms)}</small>
            </>
          ) : (
            '—'
          )}
        </dd>
      </div>
      <div class="ins-fact">
        <dt>Longest run</dt>
        <dd class="tabular">
          {f.longestRun}
          <small> {f.longestRun === 1 ? 'day' : 'days'}</small>
        </dd>
      </div>
    </dl>
  );
}

const HEAT_CELL = 12;
const HEAT_PITCH = 15;
const HEAT_TOP = 16;

/**
 * The last 12 months as a calendar (a column per week, GitHub-style), scrolled to this week. Tap a day
 * for its reading; tap it again to go back to the year's total. Its own request (a year of days).
 */
function YearHeatmap({ goal, now }: { goal: number | null; now: number }) {
  const year = useAsync(() => bridge().call('stats.get', { days: HEAT_DAYS }), []);
  const scroller = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  const today = dayKey(now);
  const grid = useMemo(() => (year.data ? yearGrid(year.data.days, now, goal) : null), [year.data, today, goal]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [grid !== null]);

  let body;
  if (!grid && year.status === 'error' && year.error) body = <ErrorState error={year.error} onRetry={() => void year.reload()} compact />;
  else if (!grid)
    body = (
      <div class="ins-card" aria-busy="true" aria-label="Loading">
        <SkeletonLine width="44%" height={12} />
        <div class="ins-heat-skel skel" />
      </div>
    );
  else {
    const cell = sel ? grid.weeks.flat().find((c) => c.date === sel) : undefined;
    // Room on the right for the newest month's label, which starts over the last column.
    const width = HEAT_WEEKS * HEAT_PITCH - (HEAT_PITCH - HEAT_CELL) + 12;
    const height = HEAT_TOP + 7 * HEAT_PITCH - (HEAT_PITCH - HEAT_CELL);
    const summary = `${plural(grid.activeDays, 'day')} read`;
    body = (
      <div class="ins-card ins-heat" data-testid="ins-heat">
        <div class="ins-readout" aria-live="polite">
          <span class="ins-readout-label" data-testid="ins-heat-day">
            {cell ? heatCellLabel(cell) : 'Last 12 months'}
          </span>
          <span class="ins-readout-value tabular" data-testid="ins-heat-total">
            {summary}
            <span class="ins-readout-sub"> · {formatDuration(grid.totalMs)}</span>
          </span>
        </div>
        <div class="ins-heat-scroll" ref={scroller}>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Reading over the last 12 months: ${summary}, ${formatDuration(grid.totalMs)} in all.`}
            onClick={(e) => {
              const date = (e.target as Element).closest('[data-date]')?.getAttribute('data-date') ?? null;
              if (date) setSel((cur) => (cur === date ? null : date));
            }}
          >
            {grid.months.map((m) => (
              <text key={`${m.col}-${m.label}`} x={m.col * HEAT_PITCH} y={10} class="ins-heat-month">
                {m.label}
              </text>
            ))}
            {grid.weeks.map((col, w) =>
              col.map((c, d) =>
                c.future ? null : (
                  <rect
                    key={c.date}
                    x={w * HEAT_PITCH}
                    y={HEAT_TOP + d * HEAT_PITCH}
                    width={HEAT_CELL}
                    height={HEAT_CELL}
                    rx={3}
                    class={`lv-${c.level}${c.date === sel ? ' is-sel' : ''}${c.date === today ? ' is-today' : ''}`}
                    data-date={c.date}
                  />
                ),
              ),
            )}
          </svg>
        </div>
        <ul class="sr-only" data-testid="ins-heat-months">
          {heatMonths(grid).map((m) => (
            <li key={m.key}>{m.days > 0 ? `${m.label}: ${plural(m.days, 'day')} read, ${durationSpoken(m.ms)}` : `${m.label}: no reading`}</li>
          ))}
        </ul>
        <div class="ins-heat-legend" aria-hidden="true">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <i key={l} class={`lv-${l}`} />
          ))}
          <span>More</span>
        </div>
      </div>
    );
  }
  return (
    <Section
      header="Your Year"
      footer={goal !== null ? 'Shades step up at half your daily goal, the goal itself, and twice it.' : 'Shades step up at 15 m, 30 m and an hour of reading a day.'}
    >
      {body}
    </Section>
  );
}

function TopNovels({ stats }: { stats: ReadingStats }) {
  const top = stats.topNovels.slice(0, 10);
  if (top.length === 0) return null;
  const max = Math.max(...top.map((n) => n.ms), 1);
  return (
    <Section header="Most Read">
      {top.map((n, i) => {
        const k = parseNovelKey(n.key);
        return (
          <button
            type="button"
            class="row tap tap-row ins-top"
            key={n.key}
            onClick={() => openNovel({ pluginId: k.pluginId, path: k.path, name: n.name, ...(n.cover !== undefined ? { cover: n.cover } : {}) })}
            data-testid="ins-top-novel"
          >
            <span class="ins-rank tabular">{i + 1}</span>
            <Cover src={n.cover} pluginId={k.pluginId} class="cover-thumb ins-top-cover" />
            <span class="row-main">
              <span class="row-title">{n.name}</span>
              <span class="ins-top-meter" aria-hidden="true">
                <i style={{ transform: `scaleX(${n.ms / max})` }} />
              </span>
            </span>
            <span class="row-value tabular">{formatDuration(n.ms)}</span>
            <Icon name="chevron.right" size={14} class="row-chevron" />
          </button>
        );
      })}
    </Section>
  );
}

function StatsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div class="ins-tiles">
        {Array.from({ length: 4 }, (_, i) => (
          <div class="ins-tile" key={i}>
            <SkeletonLine width="45%" height={11} />
            <SkeletonLine width="70%" height={26} class="ins-skel-value" />
            <SkeletonLine width="40%" height={10} />
          </div>
        ))}
      </div>
      <div class="group-body ins-card">
        <SkeletonLine width="38%" height={12} />
        <div class="ins-skel-plot skel" />
      </div>
    </div>
  );
}

function WeekSummaryCard({ stats, now }: { stats: ReadingStats; now: number }) {
  const s = weekSummary(weekVsLastWeek(stats.days, now));
  return (
    <div class={`ins-summary is-${s.trend}`} data-testid="ins-summary">
      <span class="ins-summary-icon" aria-hidden="true">
        <Icon name={s.trend === 'down' ? 'arrow.down' : s.trend === 'up' ? 'arrow.up' : 'book'} size={18} />
      </span>
      <span class="ins-summary-text">
        <span class="ins-summary-title">{s.title}</span>
        <span class="ins-summary-detail">{s.detail}</span>
      </span>
    </div>
  );
}

/**
 * "Reading report" image: drawn on a canvas, shown in a sheet, shared through the native share sheet
 * (native.shareImage: Save Image, Messages, …). If the script can't share it (an older build, or it
 * refuses), the same summary goes out as text instead.
 */
function ReportSheet(props: { open: boolean; stats: ReadingStats; goal: number | null; onClose: () => void; onShareText: () => void }) {
  const [src] = useState<string | null>(() => {
    try {
      const canvas = document.createElement('canvas');
      return drawCard(canvas, cardModel(props.stats, Date.now(), props.goal)) ? canvas.toDataURL('image/png') : null;
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false);

  async function shareImage(): Promise<void> {
    if (!src || busy) return;
    setBusy(true);
    try {
      // The call returns when the share sheet closes, which can take a while.
      await bridge().call('native.shareImage', { dataUrl: src, fileName: 'TachiNovel Reading Report.png' }, { timeoutMs: 600_000 });
    } catch (err) {
      // A timeout means the sheet may still be up: don't stack a second one on it.
      if (toUiError(err).code !== 'TIMEOUT') {
        showToast('Couldn’t share the image, so here it is as text');
        props.onShareText();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Reading Report" detents={['fit']} testId="report-sheet">
      <div class="ins-report">
        {src ? (
          <img class="ins-report-img selectable" src={src} width={CARD.width} height={CARD.height} alt="Reading report for this week" data-testid="report-image" />
        ) : (
          <p class="ins-report-note">The report image couldn’t be drawn on this device.</p>
        )}
      </div>
      <div class="sheet-pad ins-report-actions">
        {src && (
          <Button variant="filled" size="large" icon="square.and.arrow.up" onClick={() => void shareImage()} disabled={busy}>
            Share Image
          </Button>
        )}
        <Button variant={src ? 'plain' : 'tinted'} size="large" onClick={props.onShareText}>
          Share as Text
        </Button>
      </div>
    </Sheet>
  );
}

/**
 * Days fetched for the tiles, the weekly summary and the goal streak, whatever the chart shows. A goal
 * streak longer than this shows as "60+".
 */
const OVERVIEW_DAYS = 60;

export function StatsScreen() {
  const [range, setRange] = useState<StatsRange>(30);
  const overview = useAsync(() => bridge().call('stats.get', { days: OVERVIEW_DAYS }), []);
  const data = useAsync(() => bridge().call('stats.get', { days: range }), [range]);
  const [customGoal, setCustomGoal] = useState<{ n: number; open: boolean }>({ n: 0, open: false });
  const [report, setReport] = useState<{ n: number; open: boolean }>({ n: 0, open: false });
  const now = useNow();
  const head = overview.data;
  const stats = data.data;
  const goalMinutes = settings.value.readingGoal?.minutesPerDay ?? null;
  const goal = goalToMs(settings.value.readingGoal);
  const empty = head !== undefined && head.totalMs <= 0 && head.days.every((d) => d.ms <= 0) && head.topNovels.length === 0;

  function shareText(): void {
    if (!head) return;
    void bridge()
      .call('native.share', { text: weekShareText(head, Date.now(), goal) })
      .catch(() => undefined);
  }

  async function shareMenu(): Promise<void> {
    const i = await actionSheet({ title: 'Share My Week', actions: [{ title: 'Share as Text' }, { title: 'Reading Report Image…' }] });
    if (i === 0) shareText();
    else if (i === 1) setReport((r) => ({ n: r.n + 1, open: true }));
  }

  function reloadAll(silent: boolean): Promise<unknown> {
    return Promise.all([overview.reload({ silent }), data.reload({ silent })]);
  }

  function goRead(): void {
    popToRoot();
    selectTab(library.value.length > 0 ? 'library' : 'browse');
  }

  let body;
  if (!head && overview.status === 'error' && overview.error) body = <ErrorState error={overview.error} onRetry={() => void reloadAll(false)} />;
  else if (!head) body = <StatsSkeleton />;
  else if (empty)
    body = (
      <EmptyState
        icon="hourglass"
        title="No Reading Yet"
        message="Read a few chapters and your reading time, streaks and most-read novels show up here."
        action={{ label: library.value.length > 0 ? 'Go to Library' : 'Browse Sources', onClick: goRead }}
        testId="ins-empty"
      />
    );
  else
    body = (
      <>
        <WeekSummaryCard stats={head} now={now} />
        <Tiles stats={head} now={now} goal={goal} />
        <PersonalBests stats={head} now={now} />
        <GoalSection minutes={goalMinutes} onCustom={() => setCustomGoal((c) => ({ n: c.n + 1, open: true }))} />
        <Section header="Activity">
          <div class="ins-range">
            <Segmented options={RANGES} value={`${range}`} onChange={(v) => setRange(Number(v) as StatsRange)} />
          </div>
          {/* An error wins over older data: after a failed range switch that data is another range's. */}
          {data.status === 'error' && data.error ? (
            <ErrorState error={data.error} onRetry={() => void data.reload()} compact />
          ) : stats ? (
            <ActivityChart key={stats.days.length} stats={stats} now={now} busy={data.status === 'loading'} goal={goal} />
          ) : (
            <div class="ins-card" aria-busy="true" aria-label="Loading">
              <SkeletonLine width="38%" height={12} />
              <div class="ins-skel-plot skel" />
            </div>
          )}
        </Section>
        <YearHeatmap goal={goal} now={now} />
        {stats && data.status !== 'error' && <TopNovels stats={stats} />}
      </>
    );

  return (
    <Screen
      class="is-grouped"
      title="Reading Insights"
      back="More"
      testId="screen-stats"
      right={
        head && !empty ? (
          <BarButton
            icon="square.and.arrow.up"
            label="Share my week"
            onClick={() => void shareMenu()}
            testId="ins-share"
          />
        ) : undefined
      }
      onRefresh={() => reloadAll(true).then(() => undefined)}
    >
      <div class="grouped ins">{body}</div>
      {head && report.n > 0 && (
        <ReportSheet
          key={report.n}
          open={report.open}
          stats={head}
          goal={goal}
          onClose={() => setReport((r) => ({ ...r, open: false }))}
          onShareText={shareText}
        />
      )}
      <CustomGoalSheet key={customGoal.n} open={customGoal.open} initial={goalMinutes ?? 45} onClose={() => setCustomGoal((c) => ({ ...c, open: false }))} />
    </Screen>
  );
}
