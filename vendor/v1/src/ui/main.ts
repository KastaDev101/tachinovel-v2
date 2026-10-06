/** UI entry (bundled by tools/build.ts into one HTML file with a strict CSP). */
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/screens.css';
import './styles/reader.css';
import { start } from './app.tsx';
import { installTestHooks } from './dev/test-hooks.ts';
import { installCrashReporting } from './lib/crash.ts';

installCrashReporting();
if (__DEV_BUILD__ && window.__TACHI_DEV__) installTestHooks();
start();
