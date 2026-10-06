/** Source filters sheet (LNReader filter types: Picker, Checkbox, XCheckbox, Switch, Text). */
import { useEffect, useState } from 'preact/hooks';
import type { Filters } from '../../shared/lnreader/filters.ts';
import { BarButton, CheckRow, Section, SelectRow, SwitchRow } from '../components/controls.tsx';
import { Icon } from '../components/icon.tsx';
import { Sheet } from '../components/sheet.tsx';
import { cycleXCheckbox, defaultFilterValues, isDefaultFilters, toggleCheckbox, xState, type FilterValues } from '../lib/filters.ts';

export function FilterSheet(props: { open: boolean; filters: Filters; values: FilterValues; onApply: (values: FilterValues) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<FilterValues>(props.values);
  useEffect(() => {
    if (props.open) setDraft(props.values);
  }, [props.open]);

  const set = (key: string, value: unknown): void => {
    const f = props.filters[key];
    if (f) setDraft((d) => ({ ...d, [key]: { type: f.type, value } }));
  };
  const valueOf = <T,>(key: string): T => (draft[key]?.value ?? props.filters[key]?.value) as T;

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title="Filters"
      detents={['medium', 'large']}
      testId="filter-sheet"
      left={
        <BarButton
          text="Reset"
          onClick={() => setDraft(defaultFilterValues(props.filters))}
          disabled={isDefaultFilters(props.filters, draft)}
          testId="filters-reset"
        />
      }
      right={
        <BarButton
          text="Apply"
          bold
          onClick={() => {
            props.onApply(draft);
            props.onClose();
          }}
          testId="filters-apply"
        />
      }
    >
      <div class="filters">
        {Object.entries(props.filters).map(([key, f]) => {
          switch (f.type) {
            case 'Picker':
              return (
                <Section key={key}>
                  <SelectRow title={f.label} value={valueOf<string>(key)} options={f.options.map((o) => ({ value: o.value, label: o.label }))} onChange={(v) => set(key, v)} testId={`filter-${key}`} />
                </Section>
              );
            case 'Switch':
              return (
                <Section key={key}>
                  <SwitchRow title={f.label} checked={valueOf<boolean>(key)} onChange={(v) => set(key, v)} testId={`filter-${key}`} />
                </Section>
              );
            case 'Text':
              return (
                <Section key={key} header={f.label}>
                  <div class="row">
                    <input
                      class="filter-text"
                      type="text"
                      placeholder={f.label}
                      value={valueOf<string>(key)}
                      onInput={(e) => set(key, e.currentTarget.value)}
                      data-testid={`filter-${key}`}
                    />
                  </div>
                </Section>
              );
            case 'Checkbox': {
              const v = valueOf<string[]>(key);
              return (
                <Section key={key} header={f.label}>
                  {f.options.map((o) => (
                    <CheckRow key={o.value} title={o.label} checked={v.includes(o.value)} onClick={() => set(key, toggleCheckbox(v, o.value))} testId={`filter-${key}-${o.value}`} variant="checkbox" />
                  ))}
                </Section>
              );
            }
            case 'XCheckbox': {
              const v = valueOf<{ include?: string[]; exclude?: string[] }>(key);
              return (
                <Section key={key} header={f.label} footer="Tap once to include, twice to exclude.">
                  {f.options.map((o) => {
                    const s = xState(v, o.value);
                    return (
                      <button
                        type="button"
                        class="row tap tap-row"
                        key={o.value}
                        onClick={() => set(key, cycleXCheckbox(v, o.value))}
                        aria-label={`${o.label}: ${s === 'none' ? 'any' : s === 'include' ? 'included' : 'excluded'}`}
                        data-testid={`filter-${key}-${o.value}`}
                        data-state={s}
                      >
                        <span class="row-main">
                          <span class={`row-title${s === 'exclude' ? ' is-excluded' : ''}`}>{o.label}</span>
                        </span>
                        <span class={`xcheck is-${s}`}>
                          {s !== 'none' && <Icon name={s === 'include' ? 'checkmark' : 'xmark'} size={15} />}
                        </span>
                      </button>
                    );
                  })}
                </Section>
              );
            }
          }
        })}
      </div>
    </Sheet>
  );
}
