/**
 * Click-everything crawler. Breadth-first over UI states (screen stack + open modal + sub-tab), it
 * activates every visible control of every reachable state and checks what happened:
 *
 *  - no uncaught error / unhandled rejection / console.error / v1 crash box / "Something Went Wrong";
 *  - failed core calls are listed (warnings: some are expected answers, e.g. a cancelled prompt);
 *  - not a dead control: something visible changed, it navigated, opened a sheet or a native popup,
 *    called the core or a native plugin, scrolled, focused, or copied (re-tapping the current choice is
 *    allowed to do nothing);
 *  - settles within the time budget (a hung core call fails, a slow one warns);
 *  - back navigation (nav bar Back, sheet close, tab bar) returns to the state it came from, sane;
 *  - layout: no horizontal overflow or escaping content, nothing hidden behind the tab bar, no fixed
 *    controls under the status bar / home indicator, no control covered by another element.
 *
 * Native prompts (action sheets, alerts) are answered "cancel" first; every option then becomes its own
 * control ("More actions › Mark All as Read"), so menus are crawled like screens. Repeated list items
 * are sampled (two per list and screen type, one long-press). Visited states are keyed by signature and
 * every control is tried once per screen type, so the crawl terminates.
 *
 * Determinism: every control is tried from a fresh launch of the seeded app followed by the state's path
 * (so every finding's repro is "launch → path → control"), the clock and Math.random are fixed, there is
 * no network, and work is merged in a fixed order. Several workers (own WebKit + own core each) run the
 * independent tasks of one BFS level in parallel; results don't depend on which worker ran what.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { CrawlEnv } from './env.ts';
import { DEVICE } from './env.ts';
import type { ControlInfo, ControlKind, LayoutIssue, StateInfo } from './page-runtime.ts';

export interface Step {
  key: string;
  template: string;
  nth: number;
  kind: ControlKind | 'gesture';
  label: string;
  /** Answers for the native prompts this step triggers, in order (-1 = cancel). */
  answers?: number[];
  gesture?: 'center-tap' | 'edge-swipe';
  /** The control was the current choice when found (re-tapping it may legitimately do nothing). */
  selected?: boolean;
}

export type FindingKind =
  | 'page-error'
  | 'console-error'
  | 'crash'
  | 'error-state'
  | 'core-error'
  | 'dead-control'
  | 'obscured'
  | 'slow'
  | 'timeout'
  | 'back-nav'
  | 'layout'
  | 'unreachable'
  | 'harness';

export interface Finding {
  kind: FindingKind;
  severity: 'fail' | 'warn';
  state: string;
  control?: string;
  message: string;
  /** Steps from a fresh launch (labels). */
  repro: string[];
  screenshot?: string;
  count: number;
  /** Matching known-issue id (doesn't fail the run). */
  known?: string;
}

type NewFinding = Omit<Finding, 'count'>;

export interface ControlResult {
  label: string;
  kind: Step['kind'];
  outcome: 'ok' | 'noop-selected' | 'dead' | 'error' | 'skipped-disabled' | 'obscured' | 'not-found' | 'failed' | 'unreached';
  ms: number;
  effects: string[];
  answers?: number[];
}

export interface StateNode {
  index: number;
  sig: string;
  /** StateInfo.key: the BFS identity (top screen + sub-state + variant). */
  key: string;
  screen: string;
  path: Step[];
  info: StateInfo;
  screenshot?: string;
  controls: ControlResult[];
  layout: LayoutIssue[];
  /** Controls found on first visit (before sampling). */
  found: number;
  sampledOut: number;
}

export interface CrawlOptions {
  outDir: string;
  maxStates: number;
  maxActions: number;
  maxDepth: number;
  /** Settle time above this (ms) = "slow" warning. */
  slowMs: number;
  /** Max settle wait (ms); a core call still pending then = "timeout" failure. */
  budgetMs: number;
  /** Max wall time for the whole crawl (ms); remaining work is reported as skipped. */
  maxWallMs: number;
  log?: (line: string) => void;
  verbose?: boolean;
}

/** Bridge calls that happen on their own (timers, lazy images) and don't prove a tap did something. */
const PERIODIC_CORE = new Set(['progress.save', 'app.log', 'native.device', 'native.symbols', 'covers.fetch', 'images.fetch', 'app.flush']);
const NOISE_PLUGIN = /^(Haptics\.|Narration\.state$|StatusBar\.|SplashScreen\.|TachiNative\.setKeepAwake$)/;
/** Core methods that change stored data (a control that called one leaves the app changed). */
const WRITES =
  /^(settings\.set|sources\.(setEnabled|setPinned|settings\.set|install|uninstall|update)|repos\.(add|remove)|library\.(add|remove|setCategories|markRead|checkUpdates)|categories\.save|progress\.(save|markRead|bookmark)|history\.(remove|clear)|storage\.clear|downloads\.|backup\.(create|restore)|migrate\.apply|cleanup\.|narration\.set)/;
const SAMPLE_PER_TEMPLATE = 2;
const LONG_PER_TEMPLATE = 1;
const MAX_ANSWERS = 3;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function stepLabel(s: Step): string {
  if (s.kind === 'gesture') return `gesture: ${s.gesture}`;
  if (s.kind === 'longpress') return s.label;
  return `${s.kind === 'toggle' ? 'toggle' : s.kind === 'text' ? 'type in' : s.kind === 'select' ? 'pick next in' : s.kind === 'range' ? 'slide' : 'tap'} "${s.label}"`;
}

/** The screen a finding is on, however it was reached: "reader", "novel > sheet:chapter-filter-sheet". */
export function screenOf(state: string): string {
  const parts = state.replace(/ \[.*\]$/, '').split(' > ');
  const last = parts[parts.length - 1] ?? '';
  return /^(sheet|dialog):|^car-player$/.test(last) && parts.length > 1 ? `${parts[parts.length - 2]} > ${last}` : last;
}

/** Same finding = same kind, screen, control and message (numbers ignored), whatever the path. */
function findingId(f: NewFinding): string {
  const norm = f.message.replace(/\d{2,}/g, '#').slice(0, 300);
  return `${f.kind}|${screenOf(f.state)}|${f.control ?? ''}|${norm}`;
}

function shotName(f: NewFinding): string {
  return `failures/${f.kind}-${createHash('sha1').update(findingId(f)).digest('hex').slice(0, 10)}.png`;
}

interface VisitResult {
  ok: boolean;
  info?: StateInfo;
  layout: LayoutIssue[];
  controls: ControlInfo[];
  findings: NewFinding[];
}

interface TaskResult {
  result: ControlResult;
  findings: NewFinding[];
  after: StateInfo | null;
  spawn: Step[];
  /** Left the app as it found it (nothing written, no prompt answered, no failure): the page can be reused. */
  clean: boolean;
  /** Called a core method that changes stored data. */
  wrote?: boolean;
}

/** One WebKit page + one core: launches the seeded app, replays a path, tries one control. */
export class Worker {
  readonly env: CrawlEnv;
  readonly opts: CrawlOptions;
  readonly id: number;
  launches = 0;

  constructor(env: CrawlEnv, opts: CrawlOptions, id: number) {
    this.env = env;
    this.opts = opts;
    this.id = id;
  }

  private get page() {
    return this.env.page;
  }

  async st(): Promise<StateInfo> {
    return this.page.evaluate(() => (window.__qaCrawl as NonNullable<Window['__qaCrawl']>).state());
  }

  private async enumerate(): Promise<ControlInfo[]> {
    return this.page.evaluate(() => (window.__qaCrawl as NonNullable<Window['__qaCrawl']>).enumerate());
  }

  private async fingerprint(): Promise<string> {
    return this.page.evaluate(() => (window.__qaCrawl as NonNullable<Window['__qaCrawl']>).fingerprint());
  }

  private async probe(): Promise<{ errors: string[]; mutations: number; clipboard: number; opened: number; focus: string }> {
    return this.page.evaluate(() => {
      const p = (window as unknown as { __qaProbe: { errors: string[]; mutations: number; clipboard: string[]; opened: string[] } }).__qaProbe;
      const a = document.activeElement;
      return { errors: [...p.errors], mutations: p.mutations, clipboard: p.clipboard.length, opened: p.opened.length, focus: a && a !== document.body ? `${a.tagName}${a.getAttribute('data-qa-id') ?? ''}` : '' };
    });
  }

  /** Wait until no core call is in flight, no transition runs and the DOM was quiet for QUIET_MS. */
  async settle(budget = this.opts.budgetMs): Promise<{ ms: number; quiet: boolean; hung: boolean }> {
    const QUIET_MS = 120;
    const t0 = Date.now();
    let last = -1;
    let quietSince = Date.now();
    await delay(25);
    while (Date.now() - t0 < budget) {
      const m = await this.page
        .evaluate(() => (document.querySelector('.nav-root.is-animating, .nav-root.is-swiping') ? -3 : (window as unknown as { __qaProbe: { mutations: number } }).__qaProbe.mutations))
        .catch(() => -2);
      if (m !== last || m < 0 || this.env.inFlight > 0) {
        last = m;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= QUIET_MS) {
        return { ms: Math.max(0, Date.now() - t0 - QUIET_MS), quiet: true, hung: false };
      }
      await delay(30);
    }
    return { ms: Date.now() - t0, quiet: false, hung: this.env.inFlight > 0 };
  }

  private async shoot(f: NewFinding): Promise<NewFinding> {
    const file = shotName(f);
    await this.page.screenshot({ path: path.join(this.opts.outDir, file), scale: 'css' }).catch(() => undefined);
    return { ...f, screenshot: file };
  }

  /** Fresh launch of the seeded app, then replay `steps`. */
  async launch(steps: Step[]): Promise<{ ok: boolean; findings: NewFinding[] }> {
    const findings: NewFinding[] = [];
    const pe = this.env.pageErrors.length;
    const ce = this.env.consoleErrors.length;
    await this.env.reset();
    this.launches++;
    await this.settle();
    for (const e of this.env.pageErrors.slice(pe)) findings.push({ kind: 'page-error', severity: 'fail', state: 'app launch', message: e, repro: ['launch the app'] });
    for (const e of this.env.consoleErrors.slice(ce)) findings.push({ kind: 'console-error', severity: 'fail', state: 'app launch', message: e, repro: ['launch the app'] });
    for (const step of steps) {
      if (!(await this.perform(step, true))) return { ok: false, findings };
      await this.settle();
    }
    return { ok: true, findings };
  }

  /** Locate a step's element in the current DOM. */
  private async locate(step: Step): Promise<ControlInfo | null> {
    const controls = await this.enumerate();
    const sameKind = controls.filter((c) => (c.kind === 'longpress') === (step.kind === 'longpress'));
    const exact = sameKind.filter((c) => c.key === step.key);
    if (exact.length > 0) return exact[Math.min(step.nth, exact.length - 1)] as ControlInfo;
    const byTemplate = sameKind.filter((c) => c.template === step.template);
    if (byTemplate.length > step.nth) return byTemplate[step.nth] as ControlInfo;
    return null;
  }

  /** Do one step. `replay` = on the way to a state (errors swallowed, returns false). */
  private async perform(step: Step, replay: boolean): Promise<boolean> {
    this.env.answers.length = 0;
    if (step.answers) this.env.answers.push(...step.answers);
    try {
      if (step.kind === 'gesture') return await this.gesture(step);
      const c = await this.locate(step);
      if (!c) return false;
      const own = this.page.locator(`[data-qa-id="${c.qaId}"]`).first();
      const target = this.page.locator(`[data-qa-target="${c.qaId}"], [data-qa-id="${c.qaId}"]`).first();
      switch (step.kind) {
        case 'tap':
        case 'toggle':
          await target.tap({ timeout: 4000 });
          break;
        case 'longpress':
          await this.longPress(`[data-qa-long="${c.qaId}"]`);
          break;
        case 'select': {
          const n = c.options?.length ?? 0;
          const cur = c.selectedIndex ?? 0;
          await own.selectOption({ index: n > 1 ? (cur + 1) % n : 0 }, { timeout: 4000 });
          break;
        }
        case 'range':
          await own.evaluate((el) => {
            const input = el instanceof HTMLInputElement ? el : el.querySelector('input[type=range]');
            if (!(input instanceof HTMLInputElement)) return;
            const min = Number(input.min || 0);
            const max = Number(input.max || 100);
            const v = Number(input.value);
            const next = v + (max - min) / 4 > max ? min + (max - min) / 4 : v + (max - min) / 4;
            // The native value setter, so frameworks see the change like a user's.
            Reflect.set(HTMLInputElement.prototype, 'value', String(next), input);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          });
          break;
        case 'text': {
          const sample = await own.evaluate((el) => {
            const i = el as HTMLInputElement;
            const hint = `${i.type} ${i.placeholder ?? ''} ${i.getAttribute('aria-label') ?? ''} ${i.name ?? ''}`.toLowerCase();
            if (/url|link|repo|http/.test(hint)) return 'https://plugins.example.test/qa-scrolls.js';
            if (i.type === 'number') return '3';
            if (i.tagName === 'TEXTAREA') return 'p { margin: 0 }';
            return 'Alpha';
          });
          await own.fill(sample, { timeout: 4000 });
          await own.press('Enter', { timeout: 1500 }).catch(() => undefined);
          break;
        }
      }
      return true;
    } catch (err) {
      if (!replay) throw err;
      return false;
    }
  }

  private async longPress(sel: string): Promise<void> {
    await this.page.locator(sel).first().scrollIntoViewIfNeeded({ timeout: 2000 });
    await this.page
      .locator(sel)
      .first()
      .evaluate(async (el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + Math.min(r.width / 2, 40);
        const y = r.top + Math.min(r.height / 2, 30);
        const target = document.elementFromPoint(x, y) ?? el;
        const init: PointerEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 77, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 };
        target.dispatchEvent(new PointerEvent('pointerdown', init));
        await new Promise((r2) => setTimeout(r2, 650));
        target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      });
  }

  private async gesture(step: Step): Promise<boolean> {
    if (step.gesture === 'center-tap') {
      await this.page.touchscreen.tap(DEVICE.viewport.width / 2, DEVICE.viewport.height / 2);
      await delay(300); // the reader waits ~250 ms for a possible double tap
      return true;
    }
    if (step.gesture === 'edge-swipe') {
      const strip = this.page.locator('.nav-root > .layer:last-child [data-testid="edge-swipe"]');
      if ((await strip.count()) === 0) return false;
      const box = await strip.boundingBox();
      if (!box) return false;
      const y = box.y + box.height / 2;
      await this.page.mouse.move(box.x + 2, y);
      await this.page.mouse.down();
      for (let x = 10; x <= 330; x += 40) {
        await this.page.mouse.move(x, y);
        await delay(12);
      }
      await this.page.mouse.up();
      return true;
    }
    return false;
  }

  /** First visit of a state: screenshot, layout checks, controls. */
  async visit(node: StateNode): Promise<VisitResult> {
    let launched = await this.launch(node.path);
    const findings = [...launched.findings];
    let info = launched.ok ? await this.st() : null;
    // A replay that misses (a tap lost to an animation, a list still loading) gets one more fresh launch
    // before the state counts as unreachable and its controls go untried.
    if (!launched.ok || info?.key !== node.key) {
      launched = await this.launch(node.path);
      findings.push(...launched.findings);
      info = launched.ok ? await this.st() : null;
    }
    if (!launched.ok || !info) return { ok: false, layout: [], controls: [], findings };
    if (info.key !== node.key) return { ok: false, info, layout: [], controls: [], findings };
    if (node.screenshot) await this.page.screenshot({ path: path.join(this.opts.outDir, node.screenshot), scale: 'css' }).catch(() => undefined);
    const repro = node.path.map(stepLabel);
    if (info.crash) findings.push(await this.shoot({ kind: 'crash', severity: 'fail', state: node.sig, message: info.crash, repro }));
    if (info.errorState) findings.push(await this.shoot({ kind: 'error-state', severity: 'fail', state: node.sig, message: info.errorState, repro }));
    const layout = await this.page.evaluate(() => (window.__qaCrawl as NonNullable<Window['__qaCrawl']>).layout());
    for (const l of layout) findings.push(await this.shoot({ kind: 'layout', severity: l.kind === 'safe-area' ? 'warn' : 'fail', state: node.sig, message: `${l.kind}: ${l.detail}`, repro }));
    const controls = await this.enumerate();
    for (const c of controls) {
      // A toast goes away by itself within seconds (and a tap dismisses it): covering something then is a
      // warning, not a layout failure. Whether one is still up depends on timing, so it must not fail runs.
      const transient = /data-testid=toast|\.toast/.test(c.obscuredBy ?? '');
      if (c.obscuredBy && !c.disabled) findings.push(await this.shoot({ kind: 'obscured', severity: transient ? 'warn' : 'fail', state: node.sig, control: c.label, message: `"${c.label}" (${c.role}) at y=${c.rect.y} is covered by ${c.obscuredBy}`, repro }));
    }
    return { ok: true, info, layout, controls, findings };
  }

  /** Launch → path → one control, then check everything. */
  /** Fresh launch → path → one control. */
  async task(node: StateNode, step: Step): Promise<TaskResult> {
    const launched = await this.launch(node.path);
    if (!launched.ok || (await this.st()).key !== node.key) {
      return { result: { label: stepLabel(step), kind: step.kind, outcome: 'unreached', ms: 0, effects: [] }, findings: launched.findings, after: null, spawn: [], clean: false };
    }
    const r = await this.attempt(node, step);
    return { ...r, findings: [...launched.findings, ...r.findings] };
  }

  /**
   * The controls of one state, in order, on one page. After a control that left the app exactly as it
   * found it (no data written, no prompt answered, back where it started, same visible UI), the next one
   * reuses the page instead of relaunching. A failure seen on a reused page is re-checked from a fresh
   * launch, so every reported failure reproduces as "launch -> path -> control".
   */
  async group(node: StateNode, steps: Step[], stop: () => boolean): Promise<(TaskResult | undefined)[]> {
    const out: (TaskResult | undefined)[] = [];
    let ready = false;
    let base = '';
    const fresh = async (): Promise<NewFinding[] | null> => {
      const launched = await this.launch(node.path);
      if (!launched.ok || (await this.st()).key !== node.key) return null;
      base = await this.cleanFingerprint();
      await this.page.evaluate(() => (window.__qaCrawl as NonNullable<Window['__qaCrawl']>).saveScroll());
      return launched.findings;
    };
    for (const step of steps) {
      if (stop()) {
        out.push(undefined);
        continue;
      }
      const reused = ready;
      let launchFindings: NewFinding[] = [];
      if (!ready) {
        const f = await fresh();
        if (!f) {
          out.push({ result: { label: stepLabel(step), kind: step.kind, outcome: 'unreached', ms: 0, effects: [] }, findings: [], after: null, spawn: [], clean: false });
          continue;
        }
        launchFindings = f;
      }
      let r = await this.attempt(node, step);
      // Every failure is tried a second time from a fresh launch: one that doesn't come back was caused by
      // an earlier control on a reused page, or by timing (a loaded CI machine); it stays a warning.
      if (r.findings.some((f) => f.severity === 'fail')) {
        const f = await fresh();
        if (f) {
          const again = await this.attempt(node, step);
          if (!again.findings.some((x) => x.severity === 'fail')) {
            const first = r.findings.find((x) => x.severity === 'fail') as NewFinding;
            const why = reused ? 'only after other controls of this screen were tried first' : 'once, but not again from a fresh launch (timing?)';
            again.findings.push({ ...first, severity: 'warn', message: `${why}: ${first.message}` });
          }
          r = { ...again, findings: [...f, ...again.findings] };
        }
      }
      out.push({ ...r, findings: [...launchFindings, ...r.findings] });
      ready = false;
      let why = 'not clean';
      if (r.clean) {
        const st = await this.st().catch(() => null);
        why = `now at ${st?.key ?? '?'}`;
        if (st?.key === node.key) {
          await this.page.evaluate(() => (window.__qaCrawl as NonNullable<Window['__qaCrawl']>).restoreScroll());
          ready = (await this.cleanFingerprint()) === base;
          why = ready ? 'reuse' : 'UI differs';
        }
      }
      if (this.opts.verbose) this.opts.log?.(`  w${this.id}   next: ${why}`);
    }
    return out;
  }

  /**
   * After a dead tap: does the control react to five quick taps (a hidden gesture, like "tap the version
   * five times") or to a mouse click (desktop WebKit's tap emulation)? Any effect counts: another state, a
   * visible change, DOM changes, a core or native call, a native popup.
   */
  private async reactsTo(step: Step, how: 'multi-tap' | 'click', sigBefore: string): Promise<boolean> {
    const c = await this.locate(step).catch(() => null);
    if (!c) return false;
    const env = this.env;
    const before = { fp: await this.fingerprint(), probe: await this.probe(), core: env.coreCalls.length, plugin: env.pluginCalls.length, ui: env.nativeUi.length };
    const target = this.page.locator(`[data-qa-target="${c.qaId}"], [data-qa-id="${c.qaId}"]`).first();
    if (how === 'click') await target.click({ timeout: 2000 }).catch(() => undefined);
    else {
      for (let i = 0; i < 5; i++) {
        await target.tap({ timeout: 2000 }).catch(() => undefined);
        await delay(120);
      }
    }
    await this.settle();
    const after = await this.probe();
    return (
      (await this.st()).key !== sigBefore ||
      (await this.fingerprint()) !== before.fp ||
      after.mutations > before.probe.mutations ||
      env.coreCalls.slice(before.core).some((m) => !PERIODIC_CORE.has(m)) ||
      env.pluginCalls.slice(before.plugin).some((p) => !NOISE_PLUGIN.test(`${p.plugin}.${p.method}`)) ||
      env.nativeUi.length > before.ui
    );
  }

  private async cleanFingerprint(): Promise<string> {
    return this.page.evaluate(() => (window.__qaCrawl as NonNullable<Window['__qaCrawl']>).fingerprint(false));
  }

  /** One control on the current page (at `node`'s state), then every check. */
  private async attempt(node: StateNode, step: Step): Promise<TaskResult> {
    const env = this.env;
    const label = stepLabel(step) + (step.answers?.length ? ` › answers ${step.answers.join(',')}` : '');
    const repro = [...node.path.map(stepLabel), stepLabel(step)];
    const findings: NewFinding[] = [];
    const before = {
      fp: await this.fingerprint(),
      probe: await this.probe(),
      core: env.coreCalls.length,
      plugin: env.pluginCalls.length,
      ui: env.nativeUi.length,
      pageErr: env.pageErrors.length,
      consoleErr: env.consoleErrors.length,
      coreErr: env.coreErrors.length,
      misses: env.web.misses.length,
    };
    const t0 = Date.now();
    let performed: boolean;
    try {
      performed = await this.perform(step, false);
    } catch (err) {
      // Playwright colors its call log (ANSI escapes).
      const msg = String(err instanceof Error ? err.message : err)
        .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
        .split('\n');
      const intercept = msg.find((l) => /intercepts pointer events/.test(l));
      // Playwright's call log says why (not visible / not stable / covered / detached).
      const why = msg
        .filter((l) => /^\s+- /.test(l))
        .slice(-2)
        .map((l) => l.trim())
        .join(' ');
      findings.push(
        await this.shoot({
          kind: intercept ? 'obscured' : 'timeout',
          // The reader's bars overlay the page while shown (a tap on the text hides them): a control they
          // cover at the end of the page is reachable, just not with the bars up.
          severity: intercept && /class="rd-(bottom|top)"/.test(intercept) ? 'warn' : 'fail',
          state: node.sig,
          control: step.label,
          message: intercept ? `tap blocked: ${intercept.trim()}` : `${msg[0] ?? 'action failed'} ${why}`.trim(),
          repro,
        }),
      );
      return { result: { label, kind: step.kind, outcome: intercept ? 'obscured' : 'failed', ms: Date.now() - t0, effects: [] }, findings, after: null, spawn: [], clean: false };
    }
    if (!performed) return { result: { label, kind: step.kind, outcome: 'not-found', ms: 0, effects: [] }, findings, after: null, spawn: [], clean: false };
    const s = await this.settle();
    const ms = Date.now() - t0;
    const after = await this.st();
    const probe = await this.probe();
    const fp = await this.fingerprint();

    // ---- effects
    const effects: string[] = [];
    if (after.key !== node.key) effects.push(`→ ${after.sig}`);
    if (fp !== before.fp) effects.push('ui changed');
    if (probe.mutations > before.probe.mutations) effects.push(`dom×${probe.mutations - before.probe.mutations}`);
    const core = env.coreCalls.slice(before.core).filter((m) => !PERIODIC_CORE.has(m));
    if (core.length) effects.push(`core: ${[...new Set(core)].join(', ')}`);
    const plugins = env.pluginCalls
      .slice(before.plugin)
      .map((c) => `${c.plugin}.${c.method}`)
      .filter((m) => !NOISE_PLUGIN.test(m));
    if (plugins.length) effects.push(`native: ${[...new Set(plugins)].join(', ')}`);
    const prompts = env.nativeUi.slice(before.ui);
    for (const p of prompts) effects.push(`${p.kind}${p.title ? ` "${p.title}"` : ''}${p.detail ? ` ${p.detail.slice(0, 60)}` : ''}`);
    if (probe.clipboard > before.probe.clipboard) effects.push('clipboard');
    if (probe.opened > before.probe.opened) effects.push('window.open');
    if (probe.focus !== before.probe.focus && probe.focus) effects.push(`focus ${probe.focus}`);

    // ---- problems
    let outcome: ControlResult['outcome'] = 'ok';
    const add = async (kind: FindingKind, message: string, severity: Finding['severity'] = 'fail'): Promise<void> => {
      if (severity === 'fail') outcome = 'error';
      findings.push(await this.shoot({ kind, severity, state: node.sig, control: step.label, message, repro }));
    };
    for (const e of env.pageErrors.slice(before.pageErr)) await add('page-error', e);
    for (const e of probe.errors.slice(before.probe.errors.length)) if (!env.pageErrors.some((p) => e.includes((p.split('\n')[0] ?? '').slice(0, 60)))) await add('page-error', e);
    for (const e of env.consoleErrors.slice(before.consoleErr)) await add('console-error', e);
    // A prompt the crawler cancelled (install confirmation, document picker) is answered with an error by design.
    for (const e of env.coreErrors.slice(before.coreErr)) if (!/cancell?ed|No backup was picked/i.test(e)) await add('core-error', e, 'warn');
    for (const u of env.web.misses.slice(before.misses)) await add('harness', `no synthetic route for ${u}`, 'warn');
    if (after.crash && after.crash !== node.info.crash) await add('crash', after.crash);
    if (after.errorState && after.errorState !== node.info.errorState) await add('error-state', after.errorState);
    if (s.hung) await add('timeout', `a core call was still pending ${s.ms} ms after the tap`);
    else if (!s.quiet) await add('slow', `the UI kept changing for ${s.ms} ms after the tap`, 'warn');
    else if (s.ms > this.opts.slowMs) await add('slow', `settled after ${s.ms} ms (budget ${this.opts.slowMs} ms)`, 'warn');
    if (effects.length === 0) {
      if (step.selected) outcome = 'noop-selected';
      else if (step.kind !== 'longpress' && step.kind !== 'gesture') {
        // A hidden multi-tap gesture (e.g. tap the version five times) is not a dead control, just a
        // hidden one. And desktop WebKit's tap emulation drops the click when pointerdown was
        // default-prevented (v1's search ⓧ does that to keep the keyboard up); iOS WebKit still clicks
        // (bugs.webkit.org/195839). Either way: a warning, not a failure.
        const tappable = step.kind === 'tap' || step.kind === 'toggle';
        const multi = tappable && (await this.reactsTo(step, 'multi-tap', node.key));
        const clicked = tappable && !multi && (await this.reactsTo(step, 'click', node.key));
        if (multi) {
          findings.push(await this.shoot({ kind: 'dead-control', severity: 'warn', state: node.sig, control: step.label, message: `one tap on "${step.label}" does nothing, five quick taps do something (a hidden gesture)`, repro }));
        } else if (clicked) {
          findings.push(await this.shoot({ kind: 'dead-control', severity: 'warn', state: node.sig, control: step.label, message: `a touch tap on "${step.label}" did nothing but a mouse click works (WebKit tap emulation; confirm on the phone)`, repro }));
        } else {
          if (outcome === 'ok') outcome = 'dead';
          findings.push(await this.shoot({ kind: 'dead-control', severity: 'fail', state: node.sig, control: step.label, message: `tapping "${step.label}" changed nothing (no navigation, UI change, sheet, popup, core or native call)`, repro }));
        }
      }
    }

    // ---- native prompts answered "cancel": every option becomes a follow-up step.
    const spawn: Step[] = [];
    const given = step.answers?.length ?? 0;
    const firstNew = prompts.find((p) => (p.kind === 'actionSheet' || p.kind === 'alert') && p.answered === -1);
    if (firstNew?.actions && given < MAX_ANSWERS) {
      firstNew.actions.forEach((a, j) => spawn.push({ ...step, answers: [...(step.answers ?? []), j], label: `${step.label} › ${a.title}` }));
    }

    // ---- back navigation from where the control led.
    if (after.key !== node.key && !after.crash) findings.push(...(await this.checkBack(node, after, repro)));
    const wrote = env.coreCalls.slice(before.core).some((m) => WRITES.test(m));
    const answered = prompts.some((p) => p.answered !== undefined && p.answered >= 0);
    const clean = !wrote && !answered && !findings.some((f) => f.severity === 'fail') && env.inFlight === 0;
    if (this.opts.verbose) this.opts.log?.(`  w${this.id} ${String(ms).padStart(5)} ms ${outcome.padEnd(8)} ${label.slice(0, 70)}  ${effects.join('; ').slice(0, 90)}`);
    return { result: { label, kind: step.kind, outcome, ms, effects, ...(step.answers ? { answers: step.answers } : {}) }, findings, after, spawn, clean, wrote };
  }

  /** Go back with the app's own controls (Back, sheet close, tab bar, car close) and check where we land. */
  private async checkBack(node: StateNode, now: StateInfo, repro: string[]): Promise<NewFinding[]> {
    const out: NewFinding[] = [];
    let cur = now;
    for (let attempt = 0; attempt < 4 && cur.key !== node.key; attempt++) {
      let how: string;
      if (cur.modal && cur.modal !== node.info.modal) {
        how = await this.closeModal(cur.modal);
      } else if (cur.stack.length > node.info.stack.length) {
        const back = this.page.locator('.nav-root > .layer:last-child :is([data-testid="nav-back"], [data-testid="reader-back"])').first();
        if ((await back.count()) > 0 && (await back.isVisible())) {
          await back.tap({ timeout: 2000 }).catch(() => undefined);
          how = 'Back';
        } else {
          await this.page.keyboard.press('Escape');
          how = 'Escape';
        }
      } else if (cur.stack.length === 1 && node.info.stack.length === 1 && cur.stack[0] !== node.info.stack[0]) {
        const want = /^tabs:(\w+)/.exec(node.info.stack[0] ?? '')?.[1];
        if (!want) break;
        await this.page.locator(`[data-testid="tab-${want}"]`).tap({ timeout: 2000 }).catch(() => undefined);
        how = `tab ${want}`;
      } else break; // same screen, another sub-state (inner tab, reader bars): nothing to go back to
      await this.settle();
      const next = await this.st();
      const step = [...repro, how === 'Back' || how === 'panel Back' ? 'tap Back' : how];
      if (how === 'Back' && next.stack.length >= cur.stack.length) {
        out.push(await this.shoot({ kind: 'back-nav', severity: 'fail', state: cur.sig, control: 'Back', message: `the Back button did not leave ${cur.stack[cur.stack.length - 1]}`, repro: step }));
      }
      if (how === 'panel Back' && next.modal === cur.modal) {
        out.push(await this.shoot({ kind: 'back-nav', severity: 'fail', state: cur.sig, control: 'Back', message: `the Back button did not close ${cur.modal}`, repro: step }));
      }
      if (next.crash || (next.errorState && next.errorState !== node.info.errorState)) {
        out.push(await this.shoot({ kind: 'back-nav', severity: 'fail', state: next.sig, control: how, message: `after going back: ${next.crash ?? next.errorState}`, repro: step }));
      }
      if (how === 'Back' || how === 'Escape') {
        const blank = await this.page.evaluate(() => (document.querySelector<HTMLElement>('.nav-root > .layer:last-child')?.innerText ?? '').trim().length === 0);
        if (blank) out.push(await this.shoot({ kind: 'back-nav', severity: 'fail', state: next.sig, control: how, message: 'the screen is blank after going back', repro: step }));
      }
      cur = next;
    }
    return out;
  }

  private async closeModal(modal: string): Promise<string> {
    if (modal === 'car-player') {
      await this.page.locator('.tn-car [data-act="close"]').tap({ timeout: 2000 }).catch(() => undefined);
      return 'close the car player';
    }
    // v2's Voices panels and Voice Lab: their own Back/Close button.
    const panel = this.page.locator('.tn-v.is-open > .hd [data-act="close"], .tn-lab > .hd [data-act="close"]').last();
    if ((await panel.count()) > 0) {
      await panel.tap({ timeout: 2000 }).catch(() => undefined);
      return 'panel Back';
    }
    const close = this.page.locator('[aria-modal="true"]:not(.is-closing) [data-testid="sheet-close"]').last();
    if ((await close.count()) > 0 && (await close.isVisible().catch(() => false))) {
      await close.tap({ timeout: 2000 }).catch(() => undefined);
      return 'close the sheet';
    }
    const backdrop = this.page.locator('.sheet-wrap:not(.is-closing) .sheet-backdrop').last();
    if ((await backdrop.count()) > 0) {
      await backdrop.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
      return 'tap outside the sheet';
    }
    const skip = this.page.locator('[data-testid="onboarding-skip"], .rtips button').first();
    if ((await skip.count()) > 0) {
      await skip.tap({ timeout: 2000 }).catch(() => undefined);
      return 'dismiss';
    }
    await this.page.keyboard.press('Escape');
    return 'Escape';
  }
}

/** Run `fn` over `items` with every worker pulling the next item; results keep the input order. */
async function pool<T, R>(workers: Worker[], items: T[], fn: (w: Worker, item: T, index: number) => Promise<R>, stop: () => boolean): Promise<(R | undefined)[]> {
  const out = Array.from<R | undefined>({ length: items.length });
  let next = 0;
  await Promise.all(
    workers.map(async (w) => {
      while (next < items.length && !stop()) {
        const i = next++;
        out[i] = await fn(w, items[i] as T, i);
      }
    }),
  );
  return out;
}

export class Crawler {
  readonly states = new Map<string, StateNode>();
  readonly findings = new Map<string, Finding>();
  /** The visited-states graph: which control led from which state to which (state indexes). */
  readonly edges: { from: number; to: number; control: string }[] = [];
  /** `${screen}|…` tried already (once per screen type). */
  private readonly tried = new Set<string>();
  private readonly templates = new Map<string, number>();
  private actions = 0;
  private started = 0;
  /** Work left when the time/action budget ran out. */
  skipped = 0;
  readonly workers: Worker[];
  readonly opts: CrawlOptions;

  constructor(envs: CrawlEnv[], opts: CrawlOptions) {
    this.opts = opts;
    this.workers = envs.map((e, i) => new Worker(e, opts, i + 1));
    mkdirSync(path.join(opts.outDir, 'states'), { recursive: true });
    mkdirSync(path.join(opts.outDir, 'failures'), { recursive: true });
  }

  get stats(): { states: number; actions: number; resets: number; controlsFound: number; controlsTried: number; sampledOut: number; disabled: number; skipped: number; workers: number } {
    let found = 0;
    let tried = 0;
    let sampledOut = 0;
    let disabled = 0;
    for (const s of this.states.values()) {
      found += s.found;
      sampledOut += s.sampledOut;
      for (const c of s.controls) {
        if (c.outcome === 'skipped-disabled') disabled++;
        else tried++;
      }
    }
    const resets = this.workers.reduce((n, w) => n + w.launches, 0);
    return { states: this.states.size, actions: this.actions, resets, controlsFound: found, controlsTried: tried, sampledOut, disabled, skipped: this.skipped, workers: this.workers.length };
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private out(): boolean {
    return Date.now() - this.started > this.opts.maxWallMs || this.actions >= this.opts.maxActions;
  }

  private merge(list: NewFinding[]): void {
    for (const f of list) {
      const id = findingId(f);
      const prev = this.findings.get(id);
      if (prev) {
        prev.count++;
        continue;
      }
      this.findings.set(id, { ...f, count: 1 });
      this.log(`  ${f.severity === 'fail' ? 'FAIL' : 'warn'} ${f.kind}: ${f.control ? `${f.control}: ` : ''}${f.message.slice(0, 200)}`);
    }
  }

  private addState(info: StateInfo, p: Step[]): StateNode {
    const index = this.states.size + 1;
    const node: StateNode = { index, sig: info.sig, key: info.key, screen: info.screen, path: p, info, controls: [], layout: [], found: 0, sampledOut: 0, screenshot: `states/${String(index).padStart(3, '0')}.png` };
    this.states.set(info.key, node);
    return node;
  }

  /** Controls of a state to try, in DOM order, after de-duplication and sampling (deterministic). */
  private plan(node: StateNode, controls: ControlInfo[]): Step[] {
    node.found = controls.length;
    const counts = new Map<string, number>();
    const steps: Step[] = [];
    for (const c of controls) {
      const nthKey = `${c.kind === 'longpress' ? 'L' : 'C'}|${c.key}`;
      const nth = counts.get(nthKey) ?? 0;
      counts.set(nthKey, nth + 1);
      if (c.disabled) {
        const dk = `${node.screen}|disabled|${c.key}`;
        if (!this.tried.has(dk)) {
          this.tried.add(dk);
          node.controls.push({ label: c.label, kind: c.kind, outcome: 'skipped-disabled', ms: 0, effects: [] });
        }
        continue;
      }
      if (c.repeated) {
        const tk = `${node.screen}|${c.template}`;
        const used = this.templates.get(tk) ?? 0;
        if (used >= (c.kind === 'longpress' ? LONG_PER_TEMPLATE : SAMPLE_PER_TEMPLATE)) {
          node.sampledOut++;
          continue;
        }
        this.templates.set(tk, used + 1);
      }
      const key = `${node.screen}|${nthKey}|${nth}`;
      if (this.tried.has(key)) continue;
      this.tried.add(key);
      steps.push({ key: c.key, template: c.template, nth, kind: c.kind, label: c.label || c.testid || c.role, ...(c.selected ? { selected: true } : {}) });
    }
    const top = node.info.stack[node.info.stack.length - 1] ?? '';
    if (!node.info.modal && top === 'reader' && !this.tried.has(`${node.screen}|center-tap`)) {
      this.tried.add(`${node.screen}|center-tap`);
      steps.push({ key: 'gesture:center-tap', template: 'gesture', nth: 0, kind: 'gesture', gesture: 'center-tap', label: 'tap the middle of the page' });
    }
    if (!node.info.modal && node.info.stack.length > 1 && !this.tried.has(`${node.screen}|edge-swipe`)) {
      this.tried.add(`${node.screen}|edge-swipe`);
      steps.push({ key: 'gesture:edge-swipe', template: 'gesture', nth: 0, kind: 'gesture', gesture: 'edge-swipe', label: 'swipe from the left edge' });
    }
    return steps;
  }

  async run(): Promise<void> {
    this.started = Date.now();
    const first = this.workers[0] as Worker;
    const boot = await first.launch([]);
    this.merge(boot.findings);
    let frontier = [this.addState(await first.st(), [])];
    let level = 0;
    while (frontier.length > 0 && !this.out()) {
      this.log(`level ${level}: ${frontier.length} new state(s): ${frontier.map((n) => n.sig).join(' | ').slice(0, 300)}`);
      // Phase A: visit the new states (screenshot, layout, controls).
      const visits = await pool(this.workers, frontier, (w, n) => w.visit(n), () => this.out());
      let tasks: { node: StateNode; step: Step }[] = [];
      frontier.forEach((node, i) => {
        const v = visits[i];
        if (!v) return;
        this.merge(v.findings);
        if (!v.ok) {
          this.merge([{ kind: 'unreachable', severity: 'warn', state: node.sig, message: `replaying the path from a fresh launch reached ${v.info?.sig ?? 'nothing'} instead (nondeterministic UI?)`, repro: node.path.map(stepLabel) }]);
          return;
        }
        if (v.info) node.info = v.info;
        node.layout = v.layout;
        for (const step of this.plan(node, v.controls)) tasks.push({ node, step });
      });
      // Phase B: every control (+ the native-prompt options they reveal), merged in task order.
      const next: StateNode[] = [];
      while (tasks.length > 0 && !this.out()) {
        const budgetLeft = Math.max(0, this.opts.maxActions - this.actions);
        const run = tasks.slice(0, budgetLeft);
        this.skipped += tasks.length - run.length;
        // One group per state (in order); a worker runs a group's controls back to back.
        const groups: { node: StateNode; idx: number[] }[] = [];
        run.forEach((t, i) => {
          const g = groups[groups.length - 1];
          if (g && g.node === t.node) g.idx.push(i);
          else groups.push({ node: t.node, idx: [i] });
        });
        const results = Array.from<TaskResult | undefined>({ length: run.length });
        await pool(
          this.workers,
          groups,
          async (w, g) => {
            const rs = await w.group(g.node, g.idx.map((i) => (run[i] as { step: Step }).step), () => this.out());
            rs.forEach((r, k) => (results[g.idx[k] as number] = r));
          },
          () => this.out(),
        );
        const spawned: { node: StateNode; step: Step }[] = [];
        run.forEach((t, i) => {
          const r = results[i];
          if (!r) {
            this.skipped++;
            return;
          }
          this.actions++;
          t.node.controls.push(r.result);
          this.merge(r.findings);
          const after = r.after;
          // A new screen or sub-state is worth exploring; the same screen merely showing changed data (a
          // toggle that wrote a setting, a novel marked read) is not: its controls were tried already.
          const differs = after && (after.screen !== t.node.screen || after.sub.join() !== t.node.info.sub.join() || !r.wrote);
          if (after && differs && after.key !== t.node.key && !after.crash && !this.states.has(after.key) && t.node.path.length < this.opts.maxDepth && this.states.size < this.opts.maxStates) {
            next.push(this.addState(after, [...t.node.path, t.step]));
          }
          const to = after ? this.states.get(after.key) : undefined;
          if (to && to !== t.node) this.edges.push({ from: t.node.index, to: to.index, control: r.result.label });
          for (const s of r.spawn) spawned.push({ node: t.node, step: s });
        });
        tasks = spawned;
      }
      if (tasks.length) this.skipped += tasks.length;
      frontier = next;
      level++;
    }
    for (const n of frontier) {
      if (n.controls.length === 0) this.skipped++;
    }
  }
}
