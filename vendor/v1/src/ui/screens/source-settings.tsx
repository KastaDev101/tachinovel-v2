/**
 * Source settings (LNReader `pluginSettings`): one row per setting, in the plugin's order.
 * Switch → toggle, Text → field saved on blur (or Return), Select → native picker,
 * CheckboxGroup → checkmarks. Every change saves at once (`sources.settings.set`, the plugin
 * reloads); a rejected value (INVALID_ARGS) shows its reason under the setting and the previous
 * value comes back.
 */
import { useState } from 'preact/hooks';
import type { PluginSetting, PluginSettingValue, PluginSettingValues } from '../../shared/contracts/domain.ts';
import { bridge, errorText, toUiError } from '../bridge/client.ts';
import { CheckRow, Section, SelectRow, Spinner, SwitchRow } from '../components/controls.tsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/feedback.tsx';
import { useAsync } from '../components/hooks.ts';
import { Screen } from '../components/screen.tsx';
import { sourceById } from '../state/store.ts';
import { errorToast } from '../state/toast.ts';
import './browse.css';

function same(a: PluginSettingValue | undefined, b: PluginSettingValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v) => b.includes(v));
  return a === b;
}

export function SourceSettingsScreen({ pluginId }: { pluginId: string }) {
  const src = sourceById(pluginId);
  const data = useAsync(() => bridge().call('sources.settings.get', { id: pluginId }), [pluginId]);
  /** Values on screen (optimistic while saving). */
  const [values, setValues] = useState<PluginSettingValues | null>(null);
  /** Text fields being edited (saved on blur). */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const current: PluginSettingValues = values ?? data.data?.values ?? {};

  async function save(key: string, value: PluginSettingValue): Promise<void> {
    const prev = current[key];
    if (same(prev, value)) return;
    setValues({ ...current, [key]: value });
    setErrors(({ [key]: _gone, ...rest }) => rest);
    setSaving((s) => new Set(s).add(key));
    try {
      const r = await bridge().call('sources.settings.set', { id: pluginId, values: { [key]: value } });
      setValues(r.values);
    } catch (err) {
      const e = toUiError(err);
      // Put the previous value back; say why under the setting (or in a toast for other failures).
      setValues((v) => {
        const next = { ...(v ?? current) };
        if (prev === undefined) delete next[key];
        else next[key] = prev;
        return next;
      });
      setDrafts(({ [key]: _draft, ...rest }) => rest);
      if (e.code === 'INVALID_ARGS') setErrors((m) => ({ ...m, [key]: e.message || 'That value isn’t allowed.' }));
      else errorToast(errorText(e));
    } finally {
      setSaving((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  const errorLine = (key: string) =>
    errors[key] ? (
      <span class="setting-error" role="alert" data-testid={`setting-error-${key}`}>
        {errors[key]}
      </span>
    ) : null;

  const settingRows = (key: string, s: PluginSetting) => {
    switch (s.type) {
      case 'Switch': {
        const v = current[key];
        return (
          <Section key={key} footer={errorLine(key) ?? undefined}>
            <SwitchRow title={s.label} checked={typeof v === 'boolean' ? v : s.value} onChange={(on) => void save(key, on)} testId={`setting-${key}`} />
          </Section>
        );
      }
      case 'Text': {
        const v = current[key];
        const text = drafts[key] ?? (typeof v === 'string' ? v : s.value);
        const commit = (): void => {
          const d = drafts[key];
          if (d === undefined) return;
          setDrafts(({ [key]: _done, ...rest }) => rest);
          void save(key, d);
        };
        return (
          <Section key={key} header={s.label} footer={errorLine(key) ?? undefined}>
            <div class="row setting-text-row">
              <input
                class="filter-text setting-text"
                type="text"
                value={text}
                placeholder={s.value || s.label}
                autoComplete="off"
                autoCapitalize="off"
                spellcheck={false}
                enterKeyHint="done"
                aria-label={s.label}
                onInput={(e) => {
                  const t = e.currentTarget.value;
                  setDrafts((m) => ({ ...m, [key]: t }));
                }}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                data-testid={`setting-${key}`}
              />
              {saving.has(key) && <Spinner size={16} />}
            </div>
          </Section>
        );
      }
      case 'Select': {
        const v = current[key];
        return (
          <Section key={key} footer={errorLine(key) ?? undefined}>
            <SelectRow
              title={s.label}
              value={typeof v === 'string' ? v : s.value}
              options={s.options.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(nv) => void save(key, nv)}
              testId={`setting-${key}`}
            />
          </Section>
        );
      }
      case 'CheckboxGroup': {
        const v = current[key];
        const list = Array.isArray(v) ? v : s.value;
        return (
          <Section key={key} header={s.label} footer={errorLine(key) ?? undefined}>
            {s.options.map((o) => (
              <CheckRow
                key={o.value}
                title={o.label}
                checked={list.includes(o.value)}
                onClick={() => void save(key, list.includes(o.value) ? list.filter((x) => x !== o.value) : [...list, o.value])}
                testId={`setting-${key}-${o.value}`}
              />
            ))}
          </Section>
        );
      }
    }
  };

  const schema = data.data?.schema;
  const entries = schema ? Object.entries(schema) : [];
  return (
    <Screen class="is-grouped" title={src ? `${src.name} Settings` : 'Source Settings'} back testId="screen-source-settings">
      <div class="grouped" data-testid="source-settings">
        {data.status === 'loading' && !data.data ? (
          <SkeletonRows count={4} height={48} />
        ) : data.status === 'error' && data.error && !data.data ? (
          <ErrorState error={data.error} onRetry={() => void data.reload()} />
        ) : entries.length === 0 ? (
          <EmptyState icon="gearshape" title="No Settings" message={`${src?.name ?? 'This source'} has nothing to set.`} />
        ) : (
          <>
            {entries.map(([key, s]) => settingRows(key, s))}
            <p class="group-footer settings-reload-note">Changes are saved at once and the source reloads to apply them. Other settings and your library aren’t affected.</p>
          </>
        )}
      </div>
    </Screen>
  );
}
