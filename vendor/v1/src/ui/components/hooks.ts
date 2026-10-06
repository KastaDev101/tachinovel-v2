/** Shared hooks: async loading with stale-response dropping, clock ticks. */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { toUiError, type UiError } from '../bridge/client.ts';

export interface AsyncState<T> {
  status: 'loading' | 'ok' | 'error';
  data: T | undefined;
  error: UiError | undefined;
  /** Re-run; `silent` keeps the current data on screen (no skeleton). */
  reload: (opts?: { silent?: boolean }) => Promise<void>;
  setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ status: AsyncState<T>['status']; data: T | undefined; error: UiError | undefined }>({
    status: 'loading',
    data: undefined,
    error: undefined,
  });
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = async (silent: boolean): Promise<void> => {
    const id = ++seq.current;
    if (!silent) setState((s) => ({ status: 'loading', data: s.data, error: undefined }));
    try {
      const data = await fnRef.current();
      if (id === seq.current) setState({ status: 'ok', data, error: undefined });
    } catch (err) {
      if (id === seq.current) {
        setState((s) => (silent && s.data !== undefined ? s : { status: 'error', data: s.data, error: toUiError(err) }));
      }
    }
  };

  // Layout effect: start the request in the same frame as the first render (useEffect would wait
  // for the next paint, adding a frame of latency to every screen).
  useLayoutEffect(() => {
    void run(false);
  }, deps);

  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );

  return {
    ...state,
    reload: (opts) => run(opts?.silent ?? false),
    setData: (f) => setState((s) => ({ ...s, data: f(s.data) })),
  };
}

/** Current time, refreshed every `ms` (for relative timestamps and the reader clock). */
export function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
