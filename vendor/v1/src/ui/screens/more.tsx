/** More tab: flat settings index with leading glyphs and chevrons (Tachimanga layout). */
import { Icon } from '../components/icon.tsx';
import { Screen } from '../components/screen.tsx';
import { push, type SettingsPage } from '../state/nav.ts';
import { buildVersion } from '../state/store.ts';

interface Item {
  /** A settings page, or one of the More-only screens (Reading Insights, Migrate). */
  page: SettingsPage | 'stats' | 'migrate' | 'help';
  title: string;
  icon: string;
  value?: string;
}

function MoreRow({ item }: { item: Item }) {
  return (
    <button type="button" class="mrow tap tap-row" onClick={() => push(item.page === 'stats' || item.page === 'migrate' || item.page === 'help' ? { name: item.page } : { name: 'settings', page: item.page })} data-testid={`more-${item.page}`}>
      <Icon name={item.icon} size={24} class="mrow-icon" />
      <span class="mrow-title">{item.title}</span>
      {item.value && <span class="mrow-value">{item.value}</span>}
      <Icon name="chevron.right" size={14} class="mrow-chevron" />
    </button>
  );
}

export function MoreScreen() {
  const groups: Item[][] = [
    [
      { page: 'general', title: 'General', icon: 'slider.horizontal.3' },
      { page: 'appearance', title: 'Appearance', icon: 'paintpalette' },
      { page: 'library', title: 'Library', icon: 'books.vertical.fill' },
      { page: 'reader', title: 'Reader', icon: 'doc.text' },
      { page: 'sources', title: 'Extensions', icon: 'safari' },
      { page: 'downloads', title: 'Downloads', icon: 'arrow.down.to.line' },
    ],
    [
      { page: 'stats', title: 'Reading Insights', icon: 'hourglass' },
      { page: 'migrate', title: 'Migrate', icon: 'arrow.triangle.2.circlepath' },
    ],
    [
      { page: 'backup', title: 'Backup & Restore', icon: 'clock.arrow.circlepath' },
      { page: 'storage', title: 'Storage', icon: 'internaldrive' },
    ],
    [
      { page: 'help', title: 'Help & Tips', icon: 'book' },
      { page: 'about', title: 'About', icon: 'info.circle', ...(buildVersion.value ? { value: `v${buildVersion.value}` } : {}) },
      ...(__DEV_BUILD__ && window.__TACHI_DEV__ ? [{ page: 'developer' as const, title: 'Developer', icon: 'hammer' }] : []),
    ],
  ];
  return (
    <Screen title="More" large tab="more" testId="screen-more">
      <div class="mlist">
        {groups.map((g, i) => (
          <div class="mgroup" key={i}>
            {g.map((item) => (
              <MoreRow item={item} key={item.page} />
            ))}
          </div>
        ))}
      </div>
    </Screen>
  );
}
