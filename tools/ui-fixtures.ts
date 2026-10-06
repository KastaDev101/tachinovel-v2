/**
 * Synthetic fixtures for the simulator UI tests (ci/ios-ui-tests.sh, ios/App/AppUITests). No real
 * sites, novels or user data: the demo site in tests/fixtures/demo-site, at its own address
 * https://novels.example.test/. On CI that name points at 127.0.0.1 (/etc/hosts, which the Simulator
 * uses) and this server answers with a certificate from a throwaway CA trusted only by that simulator,
 * so the app exercises its real HTTPS path (App Transport Security, source definitions must be https).
 *
 *   node tools/ui-fixtures.ts serve <port> [--cert=<pem> --key=<pem>]   HTTPS with a cert, else HTTP
 *   node tools/ui-fixtures.ts backup <www> <out.json>
 *        a sample backup made with the BUILT core (Node native mock): the demo source installed from
 *        https://novels.example.test/spec.json, "Alpha Story" in the library with reading progress in
 *        chapter 1. The UI test restores it through Settings › Backup & Restore like a user would.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';
import { type Route, startCoreInVm } from '../tests/helpers/native-mock.ts';

const root = path.resolve(import.meta.dirname, '..');
export const SITE = 'https://novels.example.test/';
const fx = (name: string): string => readFileSync(path.join(root, 'tests', 'fixtures', 'demo-site', name), 'utf8');

/** Path + query (relative to the site) → response. Unknown paths are 404. */
export function siteRoutes(): Record<string, Route> {
  const html = { 'content-type': 'text/html; charset=utf-8' };
  const empty = { body: '<html><body></body></html>', headers: html };
  return {
    'spec.json': { body: fx('spec.json'), headers: { 'content-type': 'application/json' } },
    'popular?page=1': { body: fx('popular.html'), headers: html },
    'popular?page=2': empty,
    'latest?page=1': { body: fx('popular.html'), headers: html },
    'latest?page=2': empty,
    'novel/alpha': { body: fx('novel-alpha.html'), headers: html },
    'novel/alpha/1': { body: fx('chapter-alpha-1.html'), headers: html },
    'novel/alpha/2': { body: '<html><body><div id="content"><p>Chapter 2 - The Hall</p><p>The hall was long and very quiet tonight.</p></div></body></html>', headers: html },
    'novel/alpha/3': { body: fx('chapter-alpha-3.html'), headers: html },
  };
}

/** The same routes keyed by absolute URL (what the native mock matches). */
export function absoluteRoutes(): Record<string, Route> {
  return Object.fromEntries(Object.entries(siteRoutes()).map(([k, v]) => [`${SITE}${k}`, v]));
}

export async function makeBackup(wwwDir: string): Promise<string> {
  const core = startCoreInVm({ wwwDir, routes: absoluteRoutes(), answers: [0, 0, 0] });
  try {
    await core.call('app.boot');
    await core.call('sources.install', { url: `${SITE}spec.json` });
    await core.call('library.add', { novel: { pluginId: 'demo-library', path: 'novel/alpha', name: 'Alpha Story' } });
    await core.call('progress.save', { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1', position: { percent: 0.2, paragraph: 1, offset: 0 } });
    const info = await core.call<{ fileName: string }>('backup.create');
    return readFileSync(path.join(core.dir, 'icloud', 'TachiNovel', 'backups', info.fileName), 'utf8');
  } finally {
    core.dispose();
  }
}

/** Serve the demo site on 127.0.0.1 (HTTPS when given a certificate). */
export function serve(port: number, opts: { tls?: { cert: string; key: string }; quiet?: boolean } = {}): Server {
  const routes = siteRoutes();
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const key = (req.url ?? '/').replace(/^\//, '');
    const route = routes[key];
    if (!opts.quiet) console.log(`${req.method ?? 'GET'} /${key} ${route ? (route.status ?? 200) : 404}`);
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(route.status ?? 200, route.headers ?? {}).end(route.body ?? '');
  };
  const server = opts.tls ? createHttpsServer({ cert: opts.tls.cert, key: opts.tls.key }, handler) : createHttpServer(handler);
  return server.listen(port, '127.0.0.1', () => {
    if (!opts.quiet) console.log(`fixture site on ${opts.tls ? 'https' : 'http'}://127.0.0.1:${port}/ (as ${SITE})`);
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [cmd, a, b] = args;
  const flag = (name: string): string | undefined => args.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (cmd === 'serve' && a) {
    const cert = flag('cert');
    const key = flag('key');
    serve(Number(a), cert && key ? { tls: { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') } } : {});
  } else if (cmd === 'backup' && a && b) {
    const json = await makeBackup(path.resolve(a));
    writeFileSync(b, json);
    console.log(`wrote ${b} (${json.length} bytes)`);
  } else {
    console.error('usage: node tools/ui-fixtures.ts serve <port> [--cert=<pem> --key=<pem>] | backup <www> <out.json>');
    process.exit(2);
  }
}
