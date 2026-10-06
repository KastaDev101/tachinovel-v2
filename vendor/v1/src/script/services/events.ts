/** Script → UI events. Services emit into the hub; the bridge server attaches as the sink once running. */
import type { BridgeEvents, EventName } from '../../shared/contracts/protocol.ts';

export type EmitFn = <E extends EventName>(event: E, payload: BridgeEvents[E]) => void;

const MAX_BUFFER = 200;

export class EventHub {
  private sink: EmitFn | null = null;
  private buffer: [EventName, unknown][] = [];
  private readonly keepRecent: number;
  /** Last `keepRecent` emitted events, newest last (tests/diagnostics; off by default to save memory). */
  readonly recent: { event: EventName; payload: unknown }[] = [];

  constructor(keepRecent = 0) {
    this.keepRecent = keepRecent;
  }

  emit<E extends EventName>(event: E, payload: BridgeEvents[E]): void {
    if (this.keepRecent > 0) {
      this.recent.push({ event, payload });
      if (this.recent.length > this.keepRecent) this.recent.shift();
    }
    if (this.sink) {
      this.sink(event, payload);
      return;
    }
    this.buffer.push([event, payload]);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
  }

  attach(sink: EmitFn): void {
    this.sink = sink;
    const pending = this.buffer;
    this.buffer = [];
    for (const [event, payload] of pending) (sink as (e: EventName, p: unknown) => void)(event, payload);
  }

  detach(): void {
    this.sink = null;
  }
}
