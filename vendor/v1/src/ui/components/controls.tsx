/** iOS-style controls: buttons, switches, segmented controls, steppers, sliders, grouped lists, search. */
import type { ComponentChildren, TargetedEvent } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icon.tsx';

type Variant = 'plain' | 'filled' | 'tinted' | 'gray';

export function Button(props: {
  children: ComponentChildren;
  onClick?: () => void;
  variant?: Variant;
  size?: 'small' | 'medium' | 'large';
  icon?: string;
  disabled?: boolean;
  destructive?: boolean;
  class?: string;
  label?: string;
}) {
  const v = props.variant ?? 'plain';
  const cls = [
    'btn',
    `btn-${v}`,
    `btn-${props.size ?? 'medium'}`,
    v === 'filled' ? 'tap tap-fill' : 'tap tap-dim',
    props.destructive ? 'is-destructive' : '',
    props.class ?? '',
  ].join(' ');
  return (
    <button type="button" class={cls} onClick={props.onClick} disabled={props.disabled} aria-label={props.label}>
      {props.icon && <Icon name={props.icon} />}
      {props.children !== undefined && props.children !== null && <span>{props.children}</span>}
    </button>
  );
}

/** Navigation bar button: icon (tinted) or text. */
export function BarButton(props: {
  icon?: string;
  text?: string;
  onClick: () => void;
  label?: string;
  bold?: boolean;
  disabled?: boolean;
  /** Filled accent circle (e.g. filters applied, search open). */
  active?: boolean;
  iconClass?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      class={`bar-btn tap tap-dim${props.bold ? ' is-bold' : ''}${props.icon && !props.text ? ' is-icon' : ''}${props.active ? ' is-active' : ''}`}
      onClick={props.onClick}
      aria-label={props.label ?? props.text}
      aria-pressed={props.active}
      disabled={props.disabled}
      data-testid={props.testId}
    >
      {props.icon && <Icon name={props.icon} size={props.text ? 20 : 24} {...(props.iconClass ? { class: props.iconClass } : {})} />}
      {props.text && <span>{props.text}</span>}
    </button>
  );
}

const SWITCH_SUPPORTED = typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;

/** iOS switch: native `<input type=checkbox switch>` when supported (iOS 17.4+), CSS fallback otherwise. */
export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <input
      type="checkbox"
      class={SWITCH_SUPPORTED ? 'switch is-native' : 'switch'}
      ref={(el) => el?.setAttribute('switch', '')}
      checked={props.checked}
      disabled={props.disabled}
      aria-label={props.label}
      onChange={(e) => props.onChange(e.currentTarget.checked)}
    />
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: ComponentChildren;
  aria?: string;
}

export function Segmented<T extends string>(props: { options: SegOption<T>[]; value: T; onChange: (v: T) => void; class?: string }) {
  const idx = Math.max(0, props.options.findIndex((o) => o.value === props.value));
  const n = props.options.length;
  return (
    <div class={`segmented ${props.class ?? ''}`} role="tablist" style={{ '--n': String(n), '--i': String(idx) }}>
      <div class="segmented-thumb" />
      {props.options.map((o) => (
        <button
          type="button"
          role="tab"
          aria-selected={o.value === props.value}
          aria-label={o.aria}
          class={`segmented-item${o.value === props.value ? ' is-selected' : ''}`}
          onClick={() => props.onChange(o.value)}
          key={o.value}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  label: string;
}) {
  const round = (v: number): number => Math.round(v * 100) / 100;
  const set = (v: number): void => props.onChange(round(Math.min(props.max, Math.max(props.min, v))));
  return (
    <div class="stepper" role="group" aria-label={props.label}>
      <button type="button" class="stepper-btn tap tap-dim" aria-label={`Decrease ${props.label}`} disabled={props.value <= props.min} onClick={() => set(props.value - props.step)}>
        <Icon name="minus" size={16} />
      </button>
      <span class="stepper-value tabular">{props.format ? props.format(props.value) : String(props.value)}</span>
      <button type="button" class="stepper-btn tap tap-dim" aria-label={`Increase ${props.label}`} disabled={props.value >= props.max} onClick={() => set(props.value + props.step)}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onInput: (v: number) => void;
  onCommit?: (v: number) => void;
  label: string;
  class?: string;
}) {
  const pct = ((props.value - props.min) / (props.max - props.min || 1)) * 100;
  return (
    <input
      type="range"
      class={`slider ${props.class ?? ''}`}
      min={props.min}
      max={props.max}
      step={props.step ?? 'any'}
      value={props.value}
      aria-label={props.label}
      style={{ '--pct': `${pct}%` }}
      onInput={(e) => props.onInput(Number(e.currentTarget.value))}
      onChange={(e) => props.onCommit?.(Number(e.currentTarget.value))}
    />
  );
}

// ---------- grouped lists (iOS Settings style) ----------

export function Section(props: { header?: ComponentChildren; footer?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`group ${props.class ?? ''}`}>
      {props.header !== undefined && <h3 class="group-header">{props.header}</h3>}
      <div class="group-body">{props.children}</div>
      {props.footer !== undefined && <p class="group-footer">{props.footer}</p>}
    </section>
  );
}

export function IconTile({ name, color }: { name: string; color: string }) {
  return (
    <span class="icon-tile" style={{ background: color }}>
      <Icon name={name} size={18} />
    </span>
  );
}

export function Row(props: {
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  value?: ComponentChildren;
  icon?: { name: string; color: string };
  leading?: ComponentChildren;
  trailing?: ComponentChildren;
  chevron?: boolean;
  onClick?: () => void;
  destructive?: boolean;
  tint?: boolean;
  disabled?: boolean;
  testId?: string;
  class?: string;
}) {
  const interactive = props.onClick !== undefined && !props.disabled;
  const content = (
    <>
      {props.icon && <IconTile name={props.icon.name} color={props.icon.color} />}
      {props.leading}
      <span class="row-main">
        <span class={`row-title${props.destructive ? ' is-destructive' : ''}${props.tint ? ' is-tint' : ''}`}>{props.title}</span>
        {props.subtitle !== undefined && <span class="row-subtitle">{props.subtitle}</span>}
      </span>
      {props.value !== undefined && <span class="row-value">{props.value}</span>}
      {props.trailing}
      {props.chevron && <Icon name="chevron.right" size={14} class="row-chevron" />}
    </>
  );
  if (interactive) {
    return (
      <button type="button" class={`row tap tap-row ${props.class ?? ''}`} onClick={props.onClick} data-testid={props.testId}>
        {content}
      </button>
    );
  }
  return (
    <div class={`row${props.disabled ? ' is-disabled' : ''} ${props.class ?? ''}`} data-testid={props.testId}>
      {content}
    </div>
  );
}

export function SwitchRow(props: { title: ComponentChildren; subtitle?: ComponentChildren; checked: boolean; onChange: (v: boolean) => void; icon?: { name: string; color: string }; testId?: string }) {
  const label = typeof props.title === 'string' ? props.title : undefined;
  return (
    <label class="row row-switch" data-testid={props.testId}>
      {props.icon && <IconTile name={props.icon.name} color={props.icon.color} />}
      <span class="row-main">
        <span class="row-title">{props.title}</span>
        {props.subtitle !== undefined && <span class="row-subtitle">{props.subtitle}</span>}
      </span>
      <Switch checked={props.checked} onChange={props.onChange} {...(label ? { label } : {})} />
    </label>
  );
}

/** A row whose value opens the native iOS picker (an invisible <select> covers the row). */
export function SelectRow<T extends string>(props: {
  title: ComponentChildren;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  icon?: { name: string; color: string };
  testId?: string;
}) {
  const current = props.options.find((o) => o.value === props.value)?.label ?? '';
  return (
    <div class="row row-select tap tap-row" data-testid={props.testId}>
      {props.icon && <IconTile name={props.icon.name} color={props.icon.color} />}
      <span class="row-main">
        <span class="row-title">{props.title}</span>
      </span>
      <span class="row-value">{current}</span>
      <Icon name="chevron.up.chevron.down" size={13} class="row-chevron" />
      <select
        class="row-select-native"
        value={props.value}
        aria-label={typeof props.title === 'string' ? props.title : 'Choose'}
        onChange={(e) => props.onChange(e.currentTarget.value as T)}
      >
        {props.options.map((o) => (
          <option value={o.value} key={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CheckRow(props: { title: ComponentChildren; checked: boolean; onClick: () => void; trailing?: ComponentChildren; testId?: string }) {
  return (
    <button type="button" class="row tap tap-row" onClick={props.onClick} role="menuitemcheckbox" aria-checked={props.checked} data-testid={props.testId}>
      <span class="row-main">
        <span class="row-title">{props.title}</span>
      </span>
      {props.trailing}
      <span class={`row-check${props.checked ? ' is-on' : ''}`}>
        <Icon name="checkmark" size={17} />
      </span>
    </button>
  );
}

// ---------- search field ----------

export function SearchField(props: {
  value: string;
  onInput: (v: string) => void;
  onSubmit?: (v: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  testId?: string;
}) {
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Focus as soon as it's in the DOM (takes over from primeKeyboard(), so iOS keeps the keyboard up).
  useLayoutEffect(() => {
    if (props.autoFocus) input.current?.focus({ preventScroll: true });
  }, [props.autoFocus]);
  const active = focused || props.value !== '';
  return (
    <form
      class={`search${active ? ' is-active' : ''}`}
      role="search"
      onSubmit={(e: TargetedEvent<HTMLFormElement>) => {
        e.preventDefault();
        input.current?.blur();
        props.onSubmit?.(props.value);
      }}
    >
      <div class="search-box">
        <Icon name="magnifyingglass" size={16} class="search-icon" />
        <input
          ref={input}
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellcheck={false}
          placeholder={props.placeholder ?? 'Search'}
          value={props.value}
          data-testid={props.testId}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {props.value !== '' && (
          <button
            type="button"
            class="search-clear tap tap-dim"
            aria-label="Clear"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              props.onInput('');
              input.current?.focus();
            }}
          >
            <Icon name="xmark.circle.fill" size={17} />
          </button>
        )}
      </div>
      <button
        type="button"
        class="search-cancel tap tap-dim"
        tabIndex={active ? 0 : -1}
        onClick={() => {
          props.onInput('');
          input.current?.blur();
          props.onCancel?.();
        }}
      >
        Cancel
      </button>
    </form>
  );
}

export function Chip(props: { children: ComponentChildren; selected?: boolean; onClick?: () => void }) {
  return props.onClick ? (
    <button type="button" class={`chip tap tap-dim${props.selected ? ' is-selected' : ''}`} onClick={props.onClick}>
      {props.children}
    </button>
  ) : (
    <span class={`chip${props.selected ? ' is-selected' : ''}`}>{props.children}</span>
  );
}

export function Spinner(props: { size?: number; class?: string }) {
  const s = props.size ?? 20;
  return (
    <span class={`spinner ${props.class ?? ''}`} style={{ width: `${s}px`, height: `${s}px` }} role="progressbar" aria-label="Loading">
      {Array.from({ length: 8 }, (_, i) => (
        <i key={i} style={{ transform: `rotate(${i * 45}deg)`, animationDelay: `${(i - 8) * 0.125}s` }} />
      ))}
    </span>
  );
}
