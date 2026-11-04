/**
 * Smoke test for the Host half: mounts the plugin on stub services and drives
 * its five JSON routes. Nothing is launched on the desktop — open requests and
 * the save dialog are only exercised on the rejection paths.
 *
 *   node test/host-routes.mjs
 */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const expectedRoutes = [
  '/link-menu/open',
  '/link-menu/resolve',
  '/link-menu/info',
  '/link-menu/read',
  '/link-menu/save-as',
];
check(
  'five routes registered',
  routes.size === expectedRoutes.length && expectedRoutes.every((path) => routes.has(path)),
  [...routes.keys()].join(' '),
);

const info = await call('/link-menu/info');
check('info 200', info.statusCode === 200);
const infoBody = JSON.parse(info.body);
check('info reports a base directory', infoBody.cwd === root, infoBody.cwd);
check('info reports the platform', typeof infoBody.platform === 'string');

const resolved = await post('/link-menu/resolve', { path: 'package.json' });
check('resolve POST relative 200', resolved.statusCode === 200, resolved.body);
const resolvedPath = JSON.parse(resolved.body).path;
check('resolve returns an existing path', existsSync(resolvedPath), resolvedPath);

const resolvedGet = await call('/link-menu/resolve?path=package.json');
check('resolve GET still supported', resolvedGet.statusCode === 200, resolvedGet.body);

const missing = await post('/link-menu/resolve', { path: 'no/such/file-xyz.txt' });
check('resolve missing 404', missing.statusCode === 404);

const missingGet = await call('/link-menu/resolve?path=no/such/file-xyz.txt');
check('resolve GET missing 404', missingGet.statusCode === 404);

const resolvePut = await call('/link-menu/resolve', { method: 'PUT', headers: json, body: '{}' });
check('resolve PUT 405', resolvePut.statusCode === 405);

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

const readJs = await post('/link-menu/read', { target: 'index.js' });
check('read text 200', readJs.statusCode === 200, readJs.body.slice(0, 60));
const readBody = JSON.parse(readJs.body);
check('read returns the file text', typeof readBody.text === 'string' && readBody.text.includes('link-menu/open'));

const readMissing = await post('/link-menu/read', { target: 'no/such/file-xyz.txt' });
check('read missing 404', readMissing.statusCode === 404);

const readGet = await call('/link-menu/read');
check('read GET 405', readGet.statusCode === 405);

const readWrongType = await call('/link-menu/read', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: '{}',
});
check('read non-json 415', readWrongType.statusCode === 415);

const directoryRead = await post('/link-menu/read', { target: root });
check('read directory 400', directoryRead.statusCode === 400 && JSON.parse(directoryRead.body).error === 'not-a-file');

const binaryPath = join(tmpdir(), `dsh-link-menu-binary-${process.pid}.bin`);
writeFileSync(binaryPath, Buffer.from([0x41, 0x00, 0x42]));
const binaryRead = await post('/link-menu/read', { target: binaryPath });
check('read binary 415', binaryRead.statusCode === 415 && JSON.parse(binaryRead.body).error === 'binary');
unlinkSync(binaryPath);

const saveGet = await call('/link-menu/save-as');
check('save-as GET 405', saveGet.statusCode === 405);

const saveWrongType = await call('/link-menu/save-as', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: '{}',
});
check('save-as non-json 415', saveWrongType.statusCode === 415);

const saveMissing = await post('/link-menu/save-as', { target: 'no/such/file-xyz.txt' });
check('save-as missing 404', saveMissing.statusCode === 404);

const saveDirectory = await post('/link-menu/save-as', { target: root });
check('save-as directory 400', saveDirectory.statusCode === 400 && JSON.parse(saveDirectory.body).error === 'not-a-file');

for (const dispose of disposers.reverse()) dispose();

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
