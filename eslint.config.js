// @ts-check
/**
 * ESLint for v2's own code (src/, tools/, tests/, config files). vendor/v1 is linted in the v1 repo.
 *
 * Type-aware rules come from typescript-eslint, which needs the TypeScript 6 API: `typescript` in
 * package.json is the `@typescript/typescript6` alias, while `npm run typecheck` uses TypeScript 7
 * (`@typescript/native`). See tools/typecheck.ts (TODO: drop the alias once TS 7.1 has a stable API).
 *
 * Per-context globals, the guard against "works on the PC, breaks on the phone":
 *  - core (src/core): runs in a native-owned JavaScriptCore context. No DOM, browser or Node APIs, no
 *    Capacitor; native capabilities come only through the injected `__native` host (read once in
 *    src/core/main.ts).
 *  - UI (src/ui): the WKWebView. DOM is fine; no Node APIs, no network (the UI never fetches; the CSP
 *    says connect-src 'none'), and no native-only globals (`__native` lives in the core context).
 *  - Node (tools, tests, config): anything Node offers.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const BROWSER_ONLY = [
  'window', 'self', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'indexedDB',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'URL', 'URLSearchParams',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'queueMicrotask', 'TextEncoder', 'TextDecoder', 'FormData', 'Blob', 'File', 'FileReader',
  'atob', 'btoa', 'structuredClone', 'AbortController', 'AbortSignal', 'crypto', 'performance',
  'DOMParser', 'alert', 'confirm', 'prompt', 'Headers', 'Request', 'Response', 'Event', 'CustomEvent',
  'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'Capacitor',
];
const NODE_ONLY = ['process', 'Buffer', 'require', 'module', '__dirname', '__filename', 'global', 'setImmediate'];
const NATIVE_ONLY = ['__native'];
const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];

const restrict = (names, message) => names.map((name) => ({ name, message }));

export default tseslint.config(
  {
    ignores: [
      'vendor/**', 'node_modules/**', 'www/**', 'dist/**', '.cache/**', 'coverage/**',
      'ios/**', 'android/**', 'tests/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  // ---- Core: native JavaScriptCore context ----
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...restrict(BROWSER_ONLY, 'Not available in the core JavaScriptCore context. Use the native host (src/core/platform.ts) or a v1 polyfill.'),
        ...restrict(NODE_ONLY, 'Node-only global. Not available in the app.'),
      ],
    },
  },
  // ---- UI: WKWebView ----
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...restrict(NODE_ONLY, 'Node-only global. Not available in the app.'),
        ...restrict(NATIVE_ONLY, 'Native-only global of the core context. The UI reaches the core through the Core plugin (capacitor-client.ts).'),
        ...restrict(NETWORK, "The UI never fetches (CSP connect-src 'none'). Ask the core over the bridge."),
      ],
    },
  },
);
