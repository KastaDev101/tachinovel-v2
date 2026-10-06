/**
 * Write-behind scheduler built on Platform.sleep (no setTimeout in Scriptable).
 *
 * mark() → the task runs at most `delayMs` later (trailing, not extended by further marks, so a
 * steady stream of changes still persists every `delayMs`). flush() runs it now if anything is dirty.
 * Runs never overlap; a failed run keeps the dirty flag so the next flush retries.
 */
export interface DebouncerOptions {
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
  task: () => Promise<void>;
  onError: (err: unknown) => void;
}

export class Debouncer {
  private readonly opts: DebouncerOptions;
  private dirty = false;
  private scheduled = false;
  private running: Promise<void> | null = null;
  private cancelled = false;

  constructor(opts: DebouncerOptions) {
    this.opts = opts;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get isScheduled(): boolean {
    return this.scheduled;
  }

  mark(): void {
    this.dirty = true;
    this.cancelled = false;
    if (this.scheduled) return;
    this.scheduled = true;
    void this.opts
      .sleep(this.opts.delayMs)
      .then(() => {
        this.scheduled = false;
        return this.flush();
      })
      .catch((err: unknown) => {
        this.scheduled = false;
        this.opts.onError(err);
      });
  }

  /**
   * Mark dirty without scheduling a write: persisted by the next scheduled write or flush (close).
   * For high-frequency, low-value changes (e.g. lastReadAt while reading).
   */
  markQuiet(): void {
    this.dirty = true;
    this.cancelled = false;
  }

  /** Forget pending changes (e.g. the file is being deleted). */
  cancel(): void {
    this.dirty = false;
    this.cancelled = true;
  }

  async flush(): Promise<void> {
    for (;;) {
      if (this.running) {
        await this.running;
        continue;
      }
      if (!this.dirty || this.cancelled) return;
      this.dirty = false;
      const run = this.opts.task().catch((err: unknown) => {
        this.dirty = true;
        this.opts.onError(err);
      });
      this.running = run;
      try {
        await run;
      } finally {
        this.running = null;
      }
      return;
    }
  }
}
