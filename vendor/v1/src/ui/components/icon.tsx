import { symbols } from '../state/store.ts';
import { fallbackIconUrl } from './icons.ts';

export interface IconProps {
  name: string;
  size?: number;
  class?: string;
}

/** Tintable icon: an SF Symbol PNG from the script (or the SVG fallback) used as a CSS mask. */
export function Icon({ name, size, class: cls }: IconProps) {
  const src = symbols.value[name] ?? fallbackIconUrl(name);
  const style: Record<string, string> = { '--icon': `url("${src}")` };
  if (size !== undefined) style['--icon-size'] = `${size}px`;
  return <i class={cls ? `icon ${cls}` : 'icon'} style={style} aria-hidden="true" />;
}
