/**
 * Smoke test for the Host half: mounts the plugin on stub services and drives
 * its three JSON routes. Nothing is launched on the desktop — open requests are
 * only exercised on the rejection paths.
 *
 *   node test/host-routes.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { apply } = await import(pathToFileURL(join(root, 'index.js')).href);

const routes = new Map();
const disposers = [];
const ctx = {
  effect(fn) {
    const dispose = fn();
    disposers.push(() => dispose?.());
    return () => dispose?.();
  },
  webServer: {
    register({ path, handler }) {
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  },
  workingDirectory: { defaultDirectory: root },
  workspaceRegistry: { list: () => [{ path: root }] },
};

apply(ctx, {});

function makeReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => {
    if (body) req.push(body);
    req.push(null);
  });
  return req;
}

function call(path, options = {}) {
  const handler = routes.get(path.split('?')[0]);
  if (!handler) throw new Error(`no route ${path}`);
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(chunk) {
      if (chunk) this.body += chunk;
      this.done();
    },
  };
  const finished = new Promise((resolve) => {
    res.done = resolve;
  });
  Promise.resolve(handler(makeReq({ ...options, url: path }), res)).catch((error) => {
    res.failed = String(error);
    res.done?.();
  });
  return finished.then(() => res);
}

const json = { 'content-type': 'application/json' };
const post = (path, body) => call(path, { method: 'POST', headers: json, body: JSON.stringify(body) });

let failures = 0;
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!condition) failures += 1;
}

check('three routes registered', routes.size === 3, [...routes.keys()].join(' '));

const info = await call('/link-menu/info');
check('info 200', info.statusCode === 200);
const infoBody = JSON.parse(info.body);
check('info reports a base directory', infoBody.cwd === root, infoBody.cwd);
check('info reports the platform', typeof infoBody.platform === 'string');

const resolved = await post('/link-menu/resolve', { path: 'package.json' });
check('resolve relative 200', resolved.statusCode === 200, resolved.body);
const resolvedPath = JSON.parse(resolved.body).path;
check('resolve returns an existing path', existsSync(resolvedPath), resolvedPath);

const missing = await post('/link-menu/resolve', { path: 'no/such/file-xyz.txt' });
check('resolve missing 404', missing.statusCode === 404);

const missingGet = await call('/link-menu/resolve?path=no/such/file-xyz.txt');
check('resolve GET missing 404', missingGet.statusCode === 404);

const badKind = await post('/link-menu/open', { kind: 'nope', target: 'x' });
check('open bad kind 400', badKind.statusCode === 400);

const badUrl = await post('/link-menu/open', { kind: 'url', target: 'javascript:alert(1)' });
check('open rejects non-http url', badUrl.statusCode === 400 && JSON.parse(badUrl.body).error === 'bad-url');

const getOpen = await call('/link-menu/open');
check('open GET 405', getOpen.statusCode === 405);

const wrongType = await call('/link-menu/open', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: '{}',
});
check('open non-json 415', wrongType.statusCode === 415);

for (const dispose of disposers.reverse()) dispose();

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
