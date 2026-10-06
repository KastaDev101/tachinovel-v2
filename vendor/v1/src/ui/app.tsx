/** App shell: boot, appearance, global listeners, navigation stack and the tab root. */
import { useComputed } from '@preact/signals';
import { render, type VNode } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { CategoryPickerHost } from './components/category-picker.tsx';
import { ToastHost, ErrorState } from './components/feedback.tsx';
import { Icon } from './components/icon.tsx';
import { Navigator } from './components/navigator.tsx';
import { installPressManager } from './lib/gestures.ts';
import { BrowseScreen } from './screens/browse.tsx';
import { GenreScreen, LatestScreen } from './screens/genre.tsx';
import { GlobalSearchScreen } from './screens/global-search.tsx';
import { HistoryScreen } from './screens/history.tsx';
import { LibraryScreen } from './screens/library.tsx';
import { DiagnosticsScreen } from './screens/diagnostics.tsx';
import { HelpScreen } from './screens/help.tsx';
import { MigrateScreen, MigrateSearchScreen } from './screens/migrate.tsx';
import { LaunchIntro } from './screens/onboarding.tsx';
import { ReaderTips } from './screens/reader-tips.tsx';
import { MoreScreen } from './screens/more.tsx';
import { NovelScreen } from './screens/novel.tsx';
import { ReaderScreen } from './screens/reader/reader.tsx';
import { SettingsScreen } from './screens/settings.tsx';
import { SourceScreen } from './screens/source.tsx';
import { StatsScreen } from './screens/stats.tsx';
import { UpdatesScreen } from './screens/updates.tsx';
import { activeTab, pop, selectTab, stack, type Route, type TabName } from './state/nav.ts';
import { installLifecycle } from './state/lifecycle.ts';
import { boot, bootError, booted, installEventListeners, settings, updatesBadge } from './state/store.ts';
import { tabBarHidden } from './state/ui.ts';

const TABS: { name: TabName; label: string; icon: string; render: () => VNode }[] = [
  { name: 'library', label: 'Library', icon: 'books.vertical.fill', render: () => <LibraryScreen /> },
  { name: 'updates', label: 'Updates', icon: 'bolt.fill', render: () => <UpdatesScreen /> },
  { name: 'browse', label: 'Browse', icon: 'safari', render: () => <BrowseScreen /> },
  { name: 'history', label: 'History', icon: 'clock.fill', render: () => <HistoryScreen /> },
  { name: 'more', label: 'More', icon: 'gearshape.fill', render: () => <MoreScreen /> },
];

function TabBar() {
  const tab = activeTab.value;
  const badge = updatesBadge.value;
  return (
    <nav class={`tabbar${tabBarHidden.value ? ' is-hidden' : ''}`} role="tablist" aria-label="Main">
      {TABS.map((t) => (
        <button
          type="button"
          role="tab"
          aria-selected={t.name === tab}
          class={`tabbar-item tap${t.name === tab ? ' is-active' : ''}`}
          key={t.name}
          data-testid={`tab-${t.name}`}
          onClick={() => selectTab(t.name)}
        >
          <span class="tabbar-icon">
            <Icon name={t.icon} size={26} />
            {t.name === 'updates' && badge > 0 && <span class="tabbar-badge tabular">{badge > 99 ? '99+' : badge}</span>}
          </span>
          <span class="tabbar-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

function TabsRoot() {
  const tab = activeTab.value;
  const mounted = useRef(new Set<TabName>());
  mounted.current.add(tab);
  return (
    <div class="tabs-root">
      {TABS.filter((t) => mounted.current.has(t.name)).map((t) => (
        <div class={`tab-pane${t.name === tab ? ' is-active' : ''}`} key={t.name} inert={t.name !== tab} data-tab={t.name}>
          {t.render()}
        </div>
      ))}
      <TabBar />
    </div>
  );
}

function renderRoute(route: Route): VNode {
  switch (route.name) {
    case 'tabs':
      return <TabsRoot />;
    case 'novel':
      return <NovelScreen pluginId={route.pluginId} path={route.path} {...(route.preview ? { preview: route.preview } : {})} />;
    case 'reader':
      return <ReaderScreen pluginId={route.pluginId} novelPath={route.novelPath} chapterPath={route.chapterPath} {...(route.novelName !== undefined ? { novelName: route.novelName } : {})} />;
    case 'source':
      return <SourceScreen pluginId={route.pluginId} {...(route.query !== undefined ? { query: route.query } : {})} {...(route.openFilters ? { openFilters: true } : {})} {...(route.filters ? { filters: route.filters } : {})} {...(route.mode ? { mode: route.mode } : {})} />;
    case 'globalSearch':
      return <GlobalSearchScreen {...(route.query !== undefined ? { query: route.query } : {})} />;
    case 'genre':
      return <GenreScreen genre={route.genre} {...(route.pluginId !== undefined ? { pluginId: route.pluginId } : {})} />;
    case 'latest':
      return <LatestScreen />;
    case 'settings':
      return <SettingsScreen page={route.page} />;
    case 'stats':
      return <StatsScreen />;
    case 'migrate':
      return <MigrateScreen />;
    case 'migrateSearch':
      return <MigrateSearchScreen pluginId={route.pluginId} path={route.path} />;
    case 'diagnostics':
      return <DiagnosticsScreen />;
    case 'help':
      return <HelpScreen />;
  }
}

function Splash() {
  return (
    <div class="splash" aria-busy="true">
      <div class="splash-mark">
        <Icon name="books.vertical.fill" size={44} />
      </div>
    </div>
  );
}

function App() {
  const err = bootError.value;
  const ready = booted.value;
  // Only the appearance (not every settings change) re-renders the shell.
  const appearance = useComputed(() => settings.value.appearance).value;

  useEffect(() => {
    const root = document.documentElement;
    if (appearance === 'system') root.removeAttribute('data-appearance');
    else root.setAttribute('data-appearance', appearance);
  }, [appearance]);

  if (err) {
    return (
      <div class="boot-error">
        <ErrorState error={err} onRetry={() => void boot()} />
      </div>
    );
  }
  if (!ready) return <Splash />;
  return (
    <>
      <Navigator render={renderRoute} />
      <CategoryPickerHost />
      <ToastHost />
      <LaunchIntro />
      <ReaderTips />
    </>
  );
}

function applyDevSafeArea(): void {
  const flags = window.__TACHI_DEV__;
  const sa = flags?.safeArea;
  const root = document.documentElement;
  if (sa) {
    if (sa.top !== undefined) root.style.setProperty('--safe-top', `${sa.top}px`);
    if (sa.bottom !== undefined) root.style.setProperty('--safe-bottom', `${sa.bottom}px`);
    if (sa.left !== undefined) root.style.setProperty('--safe-left', `${sa.left}px`);
    if (sa.right !== undefined) root.style.setProperty('--safe-right', `${sa.right}px`);
  }
  if (flags?.noAnimations) root.classList.add('no-animations');
}

export function start(): void {
  applyDevSafeArea();
  installPressManager();
  installEventListeners();
  installLifecycle();
  // Desktop/dev convenience: Escape or Alt+← goes back.
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Escape' || (e.altKey && e.key === 'ArrowLeft')) && !document.querySelector('.sheet-wrap, .mock-native')) {
      if (stack.peek().length > 1) pop();
    }
  });
  const host = document.getElementById('app');
  if (!host) throw new Error('#app missing');
  render(<App />, host);
  void boot();
}
