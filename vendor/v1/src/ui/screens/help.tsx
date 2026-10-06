/**
 * Help & Tips (More › Help & Tips): searchable questions and answers from lib/help-data.ts, each answer
 * expandable in place and some with a button to the right screen; plus the welcome tour and What's New.
 */
import { useState } from 'preact/hooks';
import { Button, Row, SearchField, Section } from '../components/controls.tsx';
import { EmptyState } from '../components/feedback.tsx';
import { Icon } from '../components/icon.tsx';
import { Screen } from '../components/screen.tsx';
import { HELP, searchHelp, type HelpAction, type HelpItem } from '../lib/help-data.ts';
import { popToRoot, push, selectTab } from '../state/nav.ts';
import { onboardingOpen } from './onboarding.tsx';
import { whatsNewOpen } from './whats-new.tsx';
import '../styles/extras.css';

function runAction(a: HelpAction): void {
  if ('route' in a) push(a.route);
  else {
    popToRoot();
    selectTab(a.tab);
  }
}

function HelpRow({ item, open, onToggle }: { item: HelpItem; open: boolean; onToggle: () => void }) {
  const answerId = `help-${item.id}`;
  return (
    <div class={`help-item${open ? ' is-open' : ''}`} data-testid="help-item">
      <button type="button" class="row tap tap-row help-q" aria-expanded={open} aria-controls={answerId} onClick={onToggle}>
        <span class="row-main">
          <span class="help-q-text">{item.q}</span>
        </span>
        <Icon name="chevron.down" size={14} class="help-chevron" />
      </button>
      {open && (
        <div class="help-a" id={answerId} data-testid="help-answer">
          <p class="selectable">{item.a}</p>
          {item.action && (
            <Button variant="tinted" size="small" onClick={() => item.action && runAction(item.action)}>
              {item.action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function HelpScreen() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const topics = searchHelp(HELP, query);
  const searching = query.trim() !== '';

  return (
    <Screen
      class="is-grouped"
      title="Help & Tips"
      back="More"
      testId="screen-help"
      accessory={<SearchField value={query} onInput={setQuery} placeholder="Search help" testId="help-search" />}
    >
      <div class="grouped">
        {topics.length === 0 ? (
          <EmptyState icon="magnifyingglass" title="No Matches" message={`Nothing in Help mentions “${query.trim()}”. Diagnostics can help you report it.`} action={{ label: 'Open Diagnostics', onClick: () => push({ name: 'diagnostics' }) }} />
        ) : (
          topics.map((t) => (
            <Section header={t.title} key={t.title}>
              {t.items.map((it) => (
                <HelpRow key={it.id} item={it} open={searching || open === it.id} onToggle={() => setOpen(open === it.id ? null : it.id)} />
              ))}
            </Section>
          ))
        )}
        {!searching && (
          <Section>
            <Row title="Show the Welcome Tour" tint onClick={() => (onboardingOpen.value = true)} testId="help-tour" />
            <Row title="What’s New" tint onClick={() => (whatsNewOpen.value = true)} testId="help-whats-new" />
          </Section>
        )}
      </div>
    </Screen>
  );
}
