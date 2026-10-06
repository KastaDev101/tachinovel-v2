/**
 * Category picker sheet (Tachimanga-style): a checkbox per category plus "New category…". One global
 * instance (CategoryPickerHost) serves every screen; `pickCategories()` resolves to the chosen ids, or
 * null when dismissed. Creating a category saves it right away, so its library tab appears at once.
 */
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Category } from '../../shared/contracts/domain.ts';
import { bridge, errorText, toUiError } from '../bridge/client.ts';
import { categories, sortedCategories } from '../state/store.ts';
import { errorToast } from '../state/toast.ts';
import { BarButton, Section } from './controls.tsx';
import { Icon } from './icon.tsx';
import { Sheet } from './sheet.tsx';

interface PickerRequest {
  id: number;
  title: string;
  subtitle?: string;
  selected: string[];
  confirmLabel: string;
  resolve: (ids: string[] | null) => void;
}

const request = signal<PickerRequest | null>(null);
let seq = 0;

/** Opens the picker. Resolves to the checked category ids ([] = Default), or null if dismissed. */
export function pickCategories(opts: { title?: string; subtitle?: string; selected: readonly string[]; confirmLabel?: string }): Promise<string[] | null> {
  request.peek()?.resolve(null);
  return new Promise((resolve) => {
    request.value = {
      id: ++seq,
      title: opts.title ?? 'Set Categories',
      ...(opts.subtitle !== undefined ? { subtitle: opts.subtitle } : {}),
      selected: [...opts.selected],
      confirmLabel: opts.confirmLabel ?? 'Save',
      resolve,
    };
  });
}

/** Adds a category at the end (or returns the existing one with that name). Shown immediately. */
export async function createCategory(name: string): Promise<Category | null> {
  const n = name.trim();
  if (!n) return null;
  const list = sortedCategories.peek();
  const dup = list.find((c) => c.name.toLowerCase() === n.toLowerCase());
  if (dup) return dup;
  const cat: Category = { id: `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, name: n, order: list.length };
  const next = [...list, cat].map((c, i) => ({ ...c, order: i }));
  categories.value = next;
  try {
    categories.value = await bridge().call('categories.save', { categories: next });
    return cat;
  } catch (err) {
    categories.value = list;
    errorToast(`Couldn’t create the category: ${errorText(toUiError(err))}`);
    return null;
  }
}

export function CategoryPickerHost() {
  const req = request.value;
  // Keep rendering the last request while the sheet animates out.
  const shown = useRef<PickerRequest | null>(null);
  if (req) shown.current = req;
  const view = req ?? shown.current;
  const [sel, setSel] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  /** Current input text (submit and blur both commit; whichever comes first wins). */
  const nameRef = useRef('');
  const input = useRef<HTMLInputElement>(null);
  const cats = sortedCategories.value;

  useEffect(() => {
    if (!req) return;
    const known = new Set(sortedCategories.peek().map((c) => c.id));
    setSel(req.selected.filter((id) => known.has(id)));
    setAdding(false);
    setName('');
    nameRef.current = '';
  }, [req?.id]);

  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding]);

  function finish(ids: string[] | null): void {
    const r = request.peek();
    if (!r) return;
    request.value = null;
    r.resolve(ids);
  }

  function toggle(id: string): void {
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function addNew(): Promise<void> {
    const n = nameRef.current.trim();
    nameRef.current = '';
    setName('');
    setAdding(false);
    if (!n) return;
    const cat = await createCategory(n);
    if (cat) setSel((s) => (s.includes(cat.id) ? s : [...s, cat.id]));
  }

  const ordered = cats.map((c) => c.id).filter((id) => sel.includes(id));
  return (
    <Sheet
      open={req !== null}
      onClose={() => finish(null)}
      title={view?.title}
      detents={['fit']}
      testId="category-picker"
      left={<BarButton text="Cancel" onClick={() => finish(null)} testId="category-picker-cancel" />}
      right={<BarButton text={view?.confirmLabel ?? 'Save'} bold onClick={() => finish(ordered)} testId="category-picker-save" />}
    >
      <div class="filters cat-picker">
        <Section footer={view?.subtitle ?? (sel.length === 0 ? 'No category checked: the novel goes to Default.' : undefined)}>
          {cats.map((c) => {
            const on = sel.includes(c.id);
            return (
              <button
                type="button"
                class="row tap tap-row"
                key={c.id}
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => toggle(c.id)}
                data-testid="category-option"
                data-id={c.id}
              >
                <span class={`xcheck ${on ? 'is-include' : 'is-none'}`}>{on && <Icon name="checkmark" size={15} />}</span>
                <span class="row-main">
                  <span class="row-title">{c.name}</span>
                </span>
              </button>
            );
          })}
          {adding ? (
            <form
              class="row cat-new-form"
              onSubmit={(e) => {
                e.preventDefault();
                void addNew();
              }}
            >
              <Icon name="plus" size={18} class="cat-new-icon" />
              <input
                ref={input}
                class="filter-text"
                type="text"
                placeholder="Category name"
                value={name}
                maxLength={64}
                enterKeyHint="done"
                onInput={(e) => {
                  nameRef.current = e.currentTarget.value;
                  setName(e.currentTarget.value);
                }}
                onBlur={() => void addNew()}
                data-testid="category-new-name"
              />
            </form>
          ) : (
            <button type="button" class="row tap tap-row cat-new" onClick={() => setAdding(true)} data-testid="category-new">
              <Icon name="plus" size={18} class="cat-new-icon" />
              <span class="row-main">
                <span class="row-title">New category…</span>
              </span>
            </button>
          )}
        </Section>
      </div>
    </Sheet>
  );
}
