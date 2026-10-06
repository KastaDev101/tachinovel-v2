/**
 * "What's New" sheet: the latest release from lib/whats-new-data.ts in friendly words. Shown once after
 * a build with unseen news (see screens/onboarding.tsx › LaunchIntro), and from More › About.
 */
import { signal } from '@preact/signals';
import { Button, IconTile } from '../components/controls.tsx';
import { Sheet } from '../components/sheet.tsx';
import type { WhatsNewRelease } from '../lib/whats-new-data.ts';
import '../styles/extras.css';

/** Set to open the sheet from anywhere (About › What's New). */
export const whatsNewOpen = signal(false);

export function WhatsNewSheet(props: { open: boolean; release: WhatsNewRelease; onClose: () => void }) {
  return (
    <Sheet open={props.open} onClose={props.onClose} title="What’s New" detents={['large']} testId="whats-new">
      <div class="wn">
        <p class="wn-sub">{props.release.title}</p>
        <ul class="wn-list">
          {props.release.items.map((it) => (
            <li class="wn-item" key={it.title} data-testid="whats-new-item">
              <IconTile name={it.icon} color={it.color} />
              <span class="wn-text">
                <span class="wn-title">{it.title}</span>
                <span class="wn-detail">{it.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div class="sheet-pad">
        <Button variant="filled" size="large" onClick={props.onClose}>
          Continue
        </Button>
      </div>
    </Sheet>
  );
}
