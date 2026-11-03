import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Host half of the message right-click menu.
 *
 * The browser can copy a link or a path on its own, but it cannot hand a local
 * file to the operating system. This plugin exposes two JSON routes:
 *
 *   POST /link-menu/open   { kind: 'url' | 'file' | 'reveal', target }
 *   GET  /link-menu/info   base directory for relative references
 *
 * Opening is restricted to http(s)/mailto URLs and to absolute paths that
 * actually exist, and the OS launcher is invoked with an argument array (never
 * a shell string), so a page cannot smuggle extra commands through `target`.
 */

/** Host services this plugin needs. */
export const inject = ['webServer', 'workingDirectory'];

/** Route that launches the operating system's default handler. */
const OPEN_ROUTE = '/link-menu/open';
/** Route that reports where relative references resolve from. */
const INFO_ROUTE = '/link-menu/info';

/** Upper bound for a JSON request body. */
const MAX_BODY_BYTES = 256 * 1024;
/** Upper bound for a target path or URL. */
const MAX_TARGET_LENGTH = 4096;

/** Anything that may be handed to the system browser or mail client. */
const URL_PATTERN = /^(?:https?:\/\/|mailto:)[^\s]+$/i;
/** Windows drive, UNC share, or POSIX absolute path. */
const PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/** Base directory for relative references, taken from the plugin config. */
let configuredRoot = '';

/** Read a request body, refusing anything above the limit. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Write a JSON response. */
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Resolve a client-supplied target to a local path, or undefined. */
function resolvePath(target) {
  if (typeof target !== 'string') return undefined;
  const value = target.trim();
  if (value.length === 0 || value.length > MAX_TARGET_LENGTH) return undefined;
  if (/[\u0000-\u001f]/.test(value)) return undefined;
  if (/^file:\/\//i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return PATH_PATTERN.test(value) ? value : undefined;
}

/** Start a detached, fire-and-forget process. */
function launch(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

/** Open a URL with the system default browser or mail client. */
function openUrl(target) {
  if (!URL_PATTERN.test(target)) throw new Error('bad-url');
  if (process.platform === 'win32') launch('rundll32.exe', ['url.dll,FileProtocolHandler', target]);
  else if (process.platform === 'darwin') launch('open', [target]);
  else launch('xdg-open', [target]);
}

/** Open a local file with its default application, or reveal it in the file manager. */
async function openPath(kind, target) {
  const path = resolvePath(target);
  if (path === undefined) throw new Error('bad-path');
  await stat(path);
  if (kind === 'reveal') {
    if (process.platform === 'win32') launch('explorer.exe', ['/select,', path]);
    else if (process.platform === 'darwin') launch('open', ['-R', path]);
    else launch('xdg-open', [path]);
    return;
  }
  if (process.platform === 'win32') launch('rundll32.exe', ['url.dll,FileProtocolHandler', path]);
  else if (process.platform === 'darwin') launch('open', [path]);
  else launch('xdg-open', [path]);
}

/** Handle POST /link-menu/open. */
async function handleOpen(req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'method-not-allowed' });
    return;
  }
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().includes('application/json')) {
    json(res, 415, { ok: false, error: 'unsupported-media-type' });
    return;
  }
  let payload;
  try {
    payload = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}');
  } catch {
    json(res, 400, { ok: false, error: 'bad-json' });
    return;
  }
  const kind = payload?.kind;
  const target = payload?.target;
  if (kind !== 'url' && kind !== 'file' && kind !== 'reveal') {
    json(res, 400, { ok: false, error: 'bad-kind' });
    return;
  }
  try {
    if (kind === 'url') openUrl(target);
    else await openPath(kind, target);
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'not-found' : String(error?.message ?? 'failed');
    json(res, 400, { ok: false, error: code });
  }
}

/** Handle GET /link-menu/info: the base directory of relative references. */
function handleInfo(req, res, ctx) {
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'method-not-allowed' });
    return;
  }
  let root = configuredRoot;
  if (!root) {
    try {
      const candidate = ctx?.workingDirectory?.defaultDirectory;
      if (typeof candidate === 'string' && PATH_PATTERN.test(candidate)) root = candidate;
    } catch {
      root = '';
    }
  }
  json(res, 200, {
    ok: true,
    cwd: root || process.cwd(),
    home: homedir(),
    platform: process.platform,
  });
}

/**
 * Register the routes.
 *
 * Both are exact paths and the plugin registers nothing else; the client half
 * is what draws the menu.
 */
export function apply(ctx, config) {
  if (config && typeof config.workspaceRoot === 'string') {
    const root = config.workspaceRoot.trim().replace(/[\\/]+$/, '');
    configuredRoot = PATH_PATTERN.test(root) ? root : '';
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: OPEN_ROUTE, handler: (req, res) => handleOpen(req, res) }),
    'link-menu: open route',
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: INFO_ROUTE, handler: (req, res) => handleInfo(req, res, ctx) }),
    'link-menu: info route',
  );
}
