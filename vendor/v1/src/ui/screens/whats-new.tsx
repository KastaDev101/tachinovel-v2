/**
 * "What's New" sheet: releases from lib/whats-new-data.ts in friendly words, newest first. At launch it
 * shows the ones not seen yet (see screens/onboarding.tsx › LaunchIntro); from More › About, all of them.
 */
import { signal } from '@preact/signals';
import { Button, IconTile } from '../components/controls.tsx';
import { Sheet } from '../components/sheet.tsx';
import type { WhatsNewRelease } from '../lib/whats-new-data.ts';
import '../styles/extras.css';

/** Set to open the sheet from anywhere (About › What's New). */
export const whatsNewOpen = signal(false);

export function WhatsNewSheet(props: { open: boolean; releases: readonly WhatsNewRelease[]; onClose: () => void }) {
  return (
    <Sheet open={props.open} onClose={props.onClose} title="What’s New" detents={['large']} testId="whats-new">
      <div class="wn">
        {props.releases.map((r) => (
          <section key={r.id} class="wn-release" data-testid="whats-new-release">
            <h2 class="wn-sub">{r.title}</h2>
            <ul class="wn-list">
              {r.items.map((it) => (
                <li class="wn-item" key={it.title} data-testid="whats-new-item">
                  <IconTile name={it.icon} color={it.color} />
                  <span class="wn-text">
                    <span class="wn-title">{it.title}</span>
                    <span class="wn-detail">{it.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div class="sheet-pad">
        <Button variant="filled" size="large" onClick={props.onClose}>
          Continue
        </Button>
      </div>
    </Sheet>
  );
}
