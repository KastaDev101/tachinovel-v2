/**
 * Reading Insights (More › Reading Insights, Tachimanga's statistics): a weekly summary, today / this
 * week / streak / total tiles, an optional daily goal (progress ring, goal days marked in the chart,
 * a goal-day streak), an activity bar chart (7 days, 30 days, or a year by month) drawn with plain
 * CSS, and the most-read novels. Data comes from `stats.get`; the goal lives in settings.readingGoal.
 */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { parseNovelKey, type ReadingStats } from '../../shared/contracts/domain.ts';
import { bridge } from '../bridge/client.ts';
import { BarButton, Button, Chip, Section, Segmented, SelectRow, Stepper } from '../components/controls.tsx';
import { Cover } from '../components/cover.tsx';
import { EmptyState, ErrorState, SkeletonLine } from '../components/feedback.tsx';
import { useAsync, useNow } from '../components/hooks.ts';
import { Icon } from '../components/icon.tsx';
import { Screen } from '../components/screen.tsx';
import { Sheet } from '../components/sheet.tsx';
import {
  bucketAria,
  chartBuckets,
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
  niceScale,
  parseDayKey,
  rangeFacts,
  rangeTotals,
  streakCaption,
  tickLabel,
  todayTotals,
  weekShareText,
  weekSummary,
  weekTotals,
  weekVsLastWeek,
  type StatsRange,
} from '../lib/stats-data.ts';
import { plural } from '../lib/format.ts';
import { openNovel, popToRoot, selectTab } from '../state/nav.ts';
import { library, patchSettings, settings } from '../state/store.ts';
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
 * Days fetched for the tiles, the weekly summary and the goal streak, whatever the chart shows. A goal
 * streak longer than this shows as "60+".
 */
const OVERVIEW_DAYS = 60;

export function StatsScreen() {
  const [range, setRange] = useState<StatsRange>(30);
  const overview = useAsync(() => bridge().call('stats.get', { days: OVERVIEW_DAYS }), []);
  const data = useAsync(() => bridge().call('stats.get', { days: range }), [range]);
  const [customGoal, setCustomGoal] = useState<{ n: number; open: boolean }>({ n: 0, open: false });
  const now = useNow();
  const head = overview.data;
  const stats = data.data;
  const goalMinutes = settings.value.readingGoal?.minutesPerDay ?? null;
  const goal = goalToMs(settings.value.readingGoal);
  const empty = head !== undefined && head.totalMs <= 0 && head.days.every((d) => d.ms <= 0) && head.topNovels.length === 0;

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
        <GoalSection minutes={goalMinutes} onCustom={() => setCustomGoal((c) => ({ n: c.n + 1, open: true }))} />
        <Section header="Activity">
          <div class="ins-range">
            <Segmented options={RANGES} value={`${range}`} onChange={(v) => setRange(Number(v) as StatsRange)} />
          </div>
          {stats ? (
            <ActivityChart key={stats.days.length} stats={stats} now={now} busy={data.status === 'loading'} goal={goal} />
          ) : data.status === 'error' && data.error ? (
            <ErrorState error={data.error} onRetry={() => void data.reload()} compact />
          ) : (
            <div class="ins-card" aria-busy="true" aria-label="Loading">
              <SkeletonLine width="38%" height={12} />
              <div class="ins-skel-plot skel" />
            </div>
          )}
        </Section>
        {stats && <TopNovels stats={stats} />}
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
            onClick={() => {
              void bridge()
                .call('native.share', { text: weekShareText(head, Date.now(), goal) })
                .catch(() => undefined);
            }}
            testId="ins-share"
          />
        ) : undefined
      }
      onRefresh={() => reloadAll(true).then(() => undefined)}
    >
      <div class="grouped ins">{body}</div>
      <CustomGoalSheet key={customGoal.n} open={customGoal.open} initial={goalMinutes ?? 45} onClose={() => setCustomGoal((c) => ({ ...c, open: false }))} />
    </Screen>
  );
}
