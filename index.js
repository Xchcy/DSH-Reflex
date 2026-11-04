import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Host half of the message right-click menu.
 *
 * The browser can copy a link or a path on its own, but it cannot hand a local
 * file to the operating system. This plugin exposes these JSON routes:
 *
 *   POST /link-menu/open      { kind: 'url' | 'file' | 'reveal', target }
 *   GET  /link-menu/resolve   ?path=...  → absolute path for a file reference
 *   GET  /link-menu/info      base directory for relative references
 *
 * A relative reference is resolved against every known workspace directory, so
 * a file reference from another workspace still opens. Opening is restricted to
 * http(s)/mailto URLs and to paths that actually exist, and the OS launcher is
 * invoked with an argument array (never a shell string), so a page cannot
 * smuggle extra commands through `target`.
 */

/** Host services this plugin needs. */
export const inject = ['webServer', 'workingDirectory', 'workspaceRegistry'];

/** Route that launches the operating system's default handler. */
const OPEN_ROUTE = '/link-menu/open';
/** Route that resolves a relative file reference to an absolute path. */
const RESOLVE_ROUTE = '/link-menu/resolve';
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
  if (!PATH_PATTERN.test(value)) return undefined;
  // The shell launchers expect native separators: a chip may carry `C:/a/b`,
  // while Windows explorer and rundll32 expect backslashes before launching.
  return normalize(value);
}

/** Candidate base directories for a relative reference, most useful first. */
function candidateRoots(ctx) {
  const roots = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const root = value.trim().replace(/[\\/]+$/, '');
    if (root.length === 0 || !PATH_PATTERN.test(root)) return;
    if (!roots.includes(root)) roots.push(root);
  };
  // Durable workspace order: a newly created workspace is prepended, so the
  // workspace the user is most likely looking at is tried first.
  try {
    for (const workspace of ctx?.workspaceRegistry?.list?.() ?? []) push(workspace?.path);
  } catch {
    // registry optional
  }
  push(configuredRoot);
  try {
    push(ctx?.workingDirectory?.defaultDirectory);
  } catch {
    // optional
  }
  push(process.cwd());
  return roots;
}

/**
 * Resolve a file reference that may be absolute, a `file://` URL, or a path
 * relative to one of the known workspace directories.
 * @returns {Promise<string | undefined>} an absolute path that exists.
 */
async function resolveLoosePath(ctx, target) {
  if (typeof target !== 'string') return undefined;
  const value = target.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (value.length === 0 || value.length > MAX_TARGET_LENGTH) return undefined;
  if (/[\u0000-\u001f]/.test(value)) return undefined;
  const absolute = resolvePath(value);
  if (absolute !== undefined) {
    try {
      await stat(absolute);
      return absolute;
    } catch {
      return undefined;
    }
  }
  const relative = value.replace(/:\d+(?::\d+)?$/, '').replace(/^\.?[\\/]+/, '');
  const roots = candidateRoots(ctx);
  for (const root of roots) {
    const candidate = join(root, relative);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // try the next candidate root
    }
  }
  // A chip may show only a bare file name while the file sits in a subdirectory
  // of the workspace: look one directory level down before giving up.
  if (!/[\\/]/.test(relative)) {
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(root, entry.name, relative);
        try {
          await stat(candidate);
          return candidate;
        } catch {
          // keep scanning this root
        }
      }
    }
  }
  return undefined;
}

/**
 * The Host runs with `ELECTRON_RUN_AS_NODE=1` (it is spawned by the Electron
 * app as a plain Node process). A child Electron app such as VS Code inherits
 * that variable, boots as Node, prints its version and exits, so nothing opens.
 * Strip the Electron control variables before launching anything.
 */
function launchEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.ELECTRON_ENABLE_LOGGING;
  delete env.ELECTRON_DEBUG_NOTIFICATIONS;
  return env;
}

/** Start a detached, fire-and-forget process. */
function launch(command, args, options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    // `windowsHide: true` sets STARTF_USESHOWWINDOW/SW_HIDE in the child's
    // STARTUPINFO. Electron apps inherit it and create their main window
    // hidden (VS Code opened the file but never showed the window), so only
    // console helpers such as the focus script may be hidden.
    windowsHide: options.hidden === true,
    env: launchEnv(),
  });
  child.on('error', () => {});
  child.unref();
}

/**
 * Windows refuses SetForegroundWindow from a background process (the
 * foreground lock) and a fresh PowerShell costs about 0.6 s of startup, which
 * is what made "reveal in Explorer" feel slow. One trimmed helper process is
 * started on demand, keeps the P/Invoke type compiled, and receives one short
 * command per interaction. It only lives as long as the Host.
 */
const WIN_HELPER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$lmApi = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class LMWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static List<IntPtr> FindByTitle(string[] hints) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string title = sb.ToString();
      if (title.Length == 0) return true;
      foreach (var hint in hints) {
        if (hint.Length > 0 && title.IndexOf(hint, StringComparison.OrdinalIgnoreCase) >= 0) { found.Add(h); break; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindExplorer(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      string name = cls.ToString();
      if (name != "CabinetWClass" && name != "ExploreWClass") return true;
      var sb2 = new StringBuilder(512);
      GetWindowText(h, sb2, 512);
      if (sb2.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
try { Add-Type -TypeDefinition $lmApi -Language CSharp | Out-Null } catch {}

function Activate-LmWindow {
  param([IntPtr]$Handle)
  if ($Handle -eq [IntPtr]::Zero) { return $false }
  for ($i = 0; $i -lt 3; $i++) {
    if ([LMWin]::GetForegroundWindow() -eq $Handle) { [LMWin]::ShowWindow($Handle, 9) | Out-Null; return $true }
    [LMWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [LMWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [LMWin]::ShowWindow($Handle, 9) | Out-Null
    if ([LMWin]::SetForegroundWindow($Handle)) { return $true }
    Start-Sleep -Milliseconds 80
  }
  return $false
}

function Get-LmExplorerHandle {
  param([string]$Folder)
  try {
    $shell = New-Object -ComObject Shell.Application
    foreach ($window in $shell.Windows()) {
      try {
        if ([string]$window.Document.Folder.Self.Path -eq $Folder) { return [IntPtr]$window.HWND }
      } catch {}
    }
  } catch {}
  return [IntPtr]::Zero
}

function Get-LmShell {
  if ($null -eq $global:lmShell) {
    try { $global:lmShell = New-Object -ComObject Shell.Application } catch { $global:lmShell = $null }
  }
  return $global:lmShell
}

function Start-LmExplorerSelect {
  param([string]$Path)
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:WINDIR 'explorer.exe'
    $psi.Arguments = '/select,"' + $Path + '"'
    $psi.UseShellExecute = $false
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Invoke-LmReveal {
  param([string]$Path, [string]$Folder)
  # Fast path: a user32 title lookup costs a few milliseconds, while
  # Shell.Application enumeration of many open windows takes ~0.7 s.
  $leaf = Split-Path -Leaf $Folder
  $handle = [LMWin]::FindExplorer($leaf)
  if ($handle -ne [IntPtr]::Zero) { Activate-LmWindow $handle | Out-Null; return }
  # Shell.Application.Explore reuses the folder window when one exists and
  # opens a new one in ~0.5 s; a fresh explorer.exe process costs ~1.5 s here.
  $opened = $false
  $shell = Get-LmShell
  if ($null -ne $shell) {
    try { $shell.Explore($Folder); $opened = $true } catch { $opened = $false }
  }
  if (-not $opened) { $opened = Start-LmExplorerSelect -Path $Path }
  if (-not $opened) { return }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 50
    $handle = [LMWin]::FindExplorer($leaf)
    if ($handle -ne [IntPtr]::Zero) { Activate-LmWindow $handle | Out-Null; return }
  }
  $handle = Get-LmExplorerHandle -Folder $Folder
  if ($handle -ne [IntPtr]::Zero) { Activate-LmWindow $handle | Out-Null }
}

function Invoke-LmFocusTitle {
  param([string[]]$Hints)
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 150
    $targets = [LMWin]::FindByTitle($Hints)
    if ($targets.Count -eq 0) { continue }
    if (Activate-LmWindow $targets[$targets.Count - 1]) { return }
  }
}

function Invoke-LmAction {
  param([string]$Kind, [string]$PathB64, [string]$FolderB64, [string]$HintsB64)
  try {
    if ($Kind -eq 'reveal') {
      $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PathB64))
      $folder = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($FolderB64))
      Invoke-LmReveal -Path $path -Folder $folder
    } elseif ($Kind -eq 'focus') {
      $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($HintsB64))
      $hints = @($json | ConvertFrom-Json)
      if ($hints.Count -gt 0) { Invoke-LmFocusTitle -Hints $hints }
    }
  } catch {}
}

while ($true) {
  $lmLine = [Console]::In.ReadLine()
  if ($null -eq $lmLine) { break }
  $lmText = $lmLine.Trim()
  if ($lmText.Length -gt 0) { try { Invoke-Expression $lmText } catch {} }
}
`;

let winHelper = null;

function winHelperStart() {
  if (process.platform !== 'win32') return null;
  try {
    const encoded = Buffer.from(WIN_HELPER_SCRIPT, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: launchEnv() },
    );
    child.on('error', () => {
      if (winHelper === child) winHelper = null;
    });
    child.on('exit', () => {
      if (winHelper === child) winHelper = null;
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}

/**
 * Send one command line to the helper. When the helper cannot be started the
 * same script is run once after the boot script (the one-shot process reads
 * EOF on stdin immediately, so the appended command still runs).
 */
function winHelperSend(command) {
  if (process.platform !== 'win32') return false;
  try {
    if (winHelper === null) winHelper = winHelperStart();
    if (winHelper !== null && winHelper.stdin !== null && winHelper.stdin.writable) {
      winHelper.stdin.write(`${command}\n`);
      return true;
    }
  } catch {
    winHelper = null;
  }
  try {
    const encoded = Buffer.from(`${WIN_HELPER_SCRIPT}\n${command}\n`, 'utf16le').toString('base64');
    launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      hidden: true,
    });
    return true;
  } catch {
    return false;
  }
}

function winHelperStop() {
  const child = winHelper;
  winHelper = null;
  if (child === null) return;
  try {
    child.stdin.end();
  } catch {
    // The pipe may already be gone.
  }
  try {
    child.kill();
  } catch {
    // Nothing left to terminate.
  }
}

const toBase64Utf8 = (value) => Buffer.from(String(value), 'utf8').toString('base64');

/**
 * Raise the window of an app that was just started (VS Code, the default
 * editor, the Windows "choose an app" dialog). The helper keeps looking for
 * the window while the background process creates it.
 */
function focusWindowByTitle(titleHints) {
  if (process.platform !== 'win32') return;
  const hints = (Array.isArray(titleHints) ? titleHints : [titleHints]).filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
  if (hints.length === 0) return;
  winHelperSend(`Invoke-LmAction -Kind focus -HintsB64 '${toBase64Utf8(JSON.stringify(hints))}'`);
}

/**
 * Reveal a path in Explorer. When a window already shows that folder the
 * helper selects the item there and raises it (no second window, no explorer
 * start-up cost); otherwise it starts Explorer once and focuses the window.
 */
function revealInExplorer(path, folder) {
  if (process.platform !== 'win32') return false;
  return winHelperSend(
    `Invoke-LmAction -Kind reveal -PathB64 '${toBase64Utf8(path)}' -FolderB64 '${toBase64Utf8(folder)}'`,
  );
}

/** Titles the Windows "choose an app" dialog uses in the common locales. */
const CHOOSER_HINTS = ['选取应用', '打开方式', 'How do you want to open', 'Select an app', 'Öffnen mit', 'Ouvrir avec'];

const associationCache = new Map();

/** Default (unnamed) string value of one registry key, or an empty string. */
function regDefaultValue(key) {
  try {
    const result = spawnSync('reg.exe', ['query', key, '/ve'], { windowsHide: true, timeout: 4000 });
    if (result.status !== 0 || !result.stdout) return '';
    const match = result.stdout.toString('utf8').match(/\(Default\)\s+REG_SZ\s+(.+)/);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * Whether Windows really has a default app for this extension. An extension
 * may point at a ProgId left behind by an uninstalled app (Adobe After Effects
 * leaves `.json` pointing at a missing ProgId), so the ProgId has to own an
 * open command before the shell can launch anything.
 */
function hasAssociation(extension) {
  if (process.platform !== 'win32') return true;
  const ext = extension.toLowerCase();
  if (associationCache.has(ext)) return associationCache.get(ext);
  let associated = true;
  if (ext.length > 1) {
    let progId = '';
    try {
      const userChoice = spawnSync(
        'reg.exe',
        ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`, '/v', 'ProgId'],
        { windowsHide: true, timeout: 4000 },
      );
      if (userChoice.status === 0 && userChoice.stdout) {
        const match = userChoice.stdout.toString('utf8').match(/ProgId\s+REG_SZ\s+(.+)/);
        if (match) progId = match[1].trim();
      }
    } catch {
      progId = '';
    }
    if (!progId) progId = regDefaultValue(`HKCR\\${ext}`);
    associated = progId !== '' && regDefaultValue(`HKCR\\${progId}\\shell\\open\\command`) !== '';
  }
  associationCache.set(ext, associated);
  return associated;
}

let vscodePath;

/** Locate the VS Code executable from PATH or the usual install folders. */
function findVSCode() {
  if (vscodePath !== undefined) return vscodePath;
  vscodePath = null;
  if (process.platform !== 'win32') return vscodePath;
  const candidates = [];
  for (const entry of String(process.env.PATH ?? '').split(';')) {
    const dir = entry.trim().replace(/[\\/]+$/, '');
    if (dir.length === 0) continue;
    if (!/[\\/]Microsoft VS Code[\\/]bin$/i.test(dir)) continue;
    candidates.push(join(dir, '..', 'Code.exe'));
  }
  const local = process.env.LOCALAPPDATA;
  if (local) candidates.push(join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'));
  if (process.env.ProgramFiles) {
    candidates.push(join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'));
  }
  if (process.env['ProgramFiles(x86)']) {
    candidates.push(join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        vscodePath = normalize(candidate);
        break;
      }
    } catch {
      // keep looking
    }
  }
  return vscodePath;
}

/** Open a URL with the system default browser or mail client. */
function openUrl(target) {
  if (!URL_PATTERN.test(target)) throw new Error('bad-url');
  if (process.platform === 'win32') launch('rundll32.exe', ['url.dll,FileProtocolHandler', target]);
  else if (process.platform === 'darwin') launch('open', [target]);
  else launch('xdg-open', [target]);
}

/** Open a local file with its default application, VS Code, the shell chooser, or reveal it. */
async function openPath(kind, target) {
  const path = resolvePath(target);
  if (path === undefined) throw new Error('bad-path');
  const info = await stat(path);
  if (kind === 'reveal') {
    if (process.platform === 'win32') {
      const folder = info.isDirectory() ? path : dirname(path);
      if (!revealInExplorer(path, folder)) launch('explorer.exe', ['/select,', path]);
    } else if (process.platform === 'darwin') {
      launch('open', ['-R', path]);
    } else {
      launch('xdg-open', [info.isDirectory() ? path : dirname(path)]);
    }
    return 'reveal';
  }
  if (kind === 'code') {
    const code = findVSCode();
    if (code === null) throw new Error('no-vscode');
    launch(code, [path]);
    focusWindowByTitle(basename(path));
    return 'code';
  }
  if (kind === 'choose') {
    // Windows has no default app for this extension (or the user wants another
    // one): let the shell show its "How do you want to open this file?" dialog.
    if (process.platform === 'win32') {
      launch('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', path]);
      focusWindowByTitle(CHOOSER_HINTS);
    } else if (process.platform === 'darwin') launch('open', ['-a', path]);
    else launch('xdg-open', [path]);
    return 'choose';
  }
  if (process.platform === 'win32') {
    if (!hasAssociation(extname(path))) {
      // Nothing is registered for this extension (a leftover ProgId may still
      // point at an uninstalled app), so the shell would open nothing at all.
      // Prefer the editor the user almost certainly wants over a modal dialog.
      const code = findVSCode();
      if (code !== null) {
        launch(code, [path]);
        focusWindowByTitle(basename(path));
        return 'code';
      }
      launch('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', path]);
      focusWindowByTitle(CHOOSER_HINTS);
      return 'choose';
    }
    launch('rundll32.exe', ['url.dll,FileProtocolHandler', path]);
    focusWindowByTitle(basename(path));
  } else if (process.platform === 'darwin') launch('open', [path]);
  else launch('xdg-open', [path]);
  return 'file';
}

/** Handle POST /link-menu/open. */
async function handleOpen(req, res, ctx) {
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
  if (kind !== 'url' && kind !== 'file' && kind !== 'reveal' && kind !== 'code' && kind !== 'choose') {
    json(res, 400, { ok: false, error: 'bad-kind' });
    return;
  }
  try {
    let via = 'url';
    if (kind === 'url') {
      openUrl(target);
    } else {
      const resolved = await resolveLoosePath(ctx, target);
      if (resolved === undefined) {
        json(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      via = await openPath(kind, resolved);
    }
    res.writeHead(204, { 'cache-control': 'no-store', 'x-link-menu-via': via });
    res.end();
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'not-found' : String(error?.message ?? 'failed');
    json(res, 400, { ok: false, error: code });
  }
}

/** Handle GET/POST /link-menu/resolve: absolute path for one file reference. */
async function handleResolve(req, res, ctx) {
  let target = '';
  try {
    if (req.method === 'POST') {
      const payload = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}');
      target = typeof payload?.path === 'string' ? payload.path : '';
    } else if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      target = url.searchParams.get('path') ?? '';
    } else {
      json(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }
  } catch {
    target = '';
  }
  const resolved = await resolveLoosePath(ctx, target);
  if (resolved === undefined) {
    json(res, 404, { ok: false, error: 'not-found' });
    return;
  }
  json(res, 200, { ok: true, path: resolved });
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
    vscode: Boolean(findVSCode()),
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
    () => ctx.webServer.register({ kind: 'exact', path: OPEN_ROUTE, handler: (req, res) => handleOpen(req, res, ctx) }),
    'link-menu: open route',
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: RESOLVE_ROUTE, handler: (req, res) => handleResolve(req, res, ctx) }),
    'link-menu: resolve route',
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: INFO_ROUTE, handler: (req, res) => handleInfo(req, res, ctx) }),
    'link-menu: info route',
  );
  // Boot the window helper eagerly: the first reveal/focus should not pay for
  // the PowerShell start-up and the C# compile (about 1.5-2s otherwise).
  ctx.effect(() => {
    if (process.platform === 'win32' && winHelper === null) winHelper = winHelperStart();
    return () => winHelperStop();
  }, 'link-menu: window helper');
}
