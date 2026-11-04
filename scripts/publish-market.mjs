#!/usr/bin/env node
/**
 * Submit this plugin to the awesome-dsh-plugin market index.
 *
 * It creates (or reuses) your fork of awesome-dsh-plugin/awesome-dsh-plugin,
 * puts `data/plugins/Xchcy__DSH-Reflex.yml` on a branch, and opens the pull
 * request. Safe to re-run: the fork, the branch and an already-open PR are all
 * reused instead of duplicated.
 *
 * Usage:
 *   node scripts/publish-market.mjs            # submit
 *   node scripts/publish-market.mjs --dry-run  # print what would happen
 *   node scripts/publish-market.mjs --force    # skip the "repo is 1 day old" gate
 *
 * Auth: $GITHUB_TOKEN / $GH_TOKEN, else the credential Git Credential Manager
 * already stores for github.com (the same one `git push` uses).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'Xchcy';
const REPO = 'DSH-Reflex';
const UPSTREAM = { owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin' };
const FORK = { owner: OWNER, repo: UPSTREAM.repo };
const ENTRY_FILE = 'market/Xchcy__DSH-Reflex.yml';
const ENTRY_PATH = 'data/plugins/Xchcy__DSH-Reflex.yml';
const BRANCH = 'add/xchcy-dsh-reflex';
const BASE = 'main';
const MIN_AGE_DAYS = 1;
const PR_TITLE = `Add ${OWNER}/${REPO} — right-click menu for links and file references`;

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');

/* ------------------------------------------------------------------ proxy */
/* Node's fetch ignores the Windows system proxy unless NODE_USE_ENV_PROXY is
   set, and this machine reaches GitHub only through it. Re-exec once with the
   proxy exported so the rest of the script can just use fetch(). */
if (!process.env.NODE_USE_ENV_PROXY) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || systemProxy();
  if (proxy) {
    const r = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), ...argv],
      {
        stdio: 'inherit',
        env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy, HTTP_PROXY: proxy },
      },
    );
    process.exit(r.status ?? 1);
  }
}

function systemProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out)?.[1];
    return enabled && server ? `http://${server.replace(/^https?:\/\//, '')}` : '';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------- auth */
function tokenFromGit() {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    return /^password=(.+)$/m.exec(out)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || tokenFromGit();
if (!token) {
  console.error(
    'No GitHub token. Set GITHUB_TOKEN, or sign in once with `git push` so Git Credential Manager stores one.',
  );
  process.exit(1);
}

/* -------------------------------------------------------------------- api */
const API = 'https://api.github.com';

async function api(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'dsh-link-menu-publish',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const err = new Error(`${method} ${url} -> ${res.status} ${json?.message ?? text.slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------- local entry file */
const entry = readFileSync(path.join(ROOT, ENTRY_FILE), 'utf8');
const problems = [];
if (!/^url: https:\/\/github\.com\/Xchcy\/DSH-Reflex$/m.test(entry)) problems.push('url must be exactly https://github.com/Xchcy/DSH-Reflex');
if (!/^name: Xchcy\/DSH-Reflex$/m.test(entry)) problems.push('name must be Xchcy/DSH-Reflex');
if (!/^category: \w+$/m.test(entry)) problems.push('category is missing');
if (!/^  en: "/m.test(entry)) problems.push('description.en must be quoted (it contains ": ") and start with a capital letter');
if (problems.length) {
  console.error(`market/${'Xchcy__DSH-Reflex.yml'} is not submission-ready:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

/* ------------------------------------------------------------- repository */
const repo = await api('GET', `/repos/${OWNER}/${REPO}`);
const ageDays = (Date.now() - Date.parse(repo.created_at)) / 86_400_000;
console.log(`repo ${OWNER}/${REPO}: created ${repo.created_at} (${ageDays.toFixed(2)} days ago), topics: ${(repo.topics ?? []).join(', ') || '(none)'}`);

if (ageDays < MIN_AGE_DAYS && !force) {
  const ready = new Date(Date.parse(repo.created_at) + MIN_AGE_DAYS * 86_400_000);
  console.error(
    `\nthe registry requires the repository to be at least ${MIN_AGE_DAYS} day old before a PR passes CI.\n` +
      `earliest submission: ${ready.toISOString()} (${ready.toLocaleString()})\n` +
      `re-run then, or pass --force to submit anyway (CI will fail on the age gate).`,
  );
  process.exit(2);
}

if (!(repo.topics ?? []).includes('dsh-plugin')) {
  const topics = [...new Set([...(repo.topics ?? []), 'dsh-plugin', 'deepseek-harness', 'dsh'])].slice(0, 20);
  if (dryRun) {
    console.log(`[dry-run] would set topics: ${topics.join(', ')}`);
  } else {
    await api('PUT', `/repos/${OWNER}/${REPO}/topics`, { names: topics });
    console.log(`topics -> ${topics.join(', ')}`);
  }
}

/* ------------------------------------------------------------------- fork */
let fork = null;
try {
  fork = await api('GET', `/repos/${FORK.owner}/${FORK.repo}`);
} catch (e) {
  if (e.status !== 404) throw e;
}
if (!fork) {
  if (dryRun) {
    console.log(`[dry-run] would fork ${UPSTREAM.owner}/${UPSTREAM.repo}, then commit ${ENTRY_PATH} and open a PR`);
    console.log('\n--- entry ---\n' + entry);
    process.exit(0);
  } else {
    console.log(`forking ${UPSTREAM.owner}/${UPSTREAM.repo} ...`);
    await api('POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/forks`, { default_branch_only: true });
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      try {
        fork = await api('GET', `/repos/${FORK.owner}/${FORK.repo}`);
        break;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    if (!fork) throw new Error('fork did not appear within 90s');
  }
}

if (!dryRun) {
  try {
    await api('POST', `/repos/${FORK.owner}/${FORK.repo}/merge-upstream`, { branch: BASE });
    console.log('fork synced with upstream');
  } catch (e) {
    console.log(`fork sync skipped: ${e.message}`);
  }
}

const forkMain = await api('GET', `/repos/${FORK.owner}/${FORK.repo}/git/ref/heads/${BASE}`);
const baseSha = forkMain.object.sha;

/* ----------------------------------------------------------------- branch */
let branchSha = null;
try {
  branchSha = (await api('GET', `/repos/${FORK.owner}/${FORK.repo}/git/ref/heads/${BRANCH}`)).object.sha;
} catch (e) {
  if (e.status !== 404) throw e;
}

if (dryRun) {
  console.log(`[dry-run] branch ${BRANCH} @ ${baseSha.slice(0, 8)}${branchSha ? ' (exists)' : ' (new)'}`);
} else if (!branchSha) {
  await api('POST', `/repos/${FORK.owner}/${FORK.repo}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: baseSha });
  console.log(`branch ${BRANCH} created at ${baseSha.slice(0, 8)}`);
} else if (branchSha !== baseSha) {
  await api('PATCH', `/repos/${FORK.owner}/${FORK.repo}/git/refs/heads/${BRANCH}`, { sha: baseSha, force: true });
  console.log(`branch ${BRANCH} moved to ${baseSha.slice(0, 8)}`);
}

/* ------------------------------------------------------------ entry commit */
const contentsUrl = `/repos/${FORK.owner}/${FORK.repo}/contents/${ENTRY_PATH}`;
let existingSha;
try {
  existingSha = (await api('GET', `${contentsUrl}?ref=${BRANCH}`)).sha;
} catch (e) {
  if (e.status !== 404) throw e;
}

const payload = {
  message: `Add ${OWNER}/${REPO}\n\nRight-click menu for links and file references in DSH messages.`,
  content: Buffer.from(entry, 'utf8').toString('base64'),
  branch: BRANCH,
  ...(existingSha ? { sha: existingSha } : {}),
};

if (dryRun) {
  console.log(`[dry-run] would commit ${ENTRY_PATH} to ${BRANCH}`);
  console.log('\n--- entry ---\n' + entry);
} else {
  await api('PUT', contentsUrl, payload);
  console.log(`committed ${ENTRY_PATH} to ${BRANCH}`);
}

/* --------------------------------------------------------------------- pr */
const head = `${FORK.owner}:${BRANCH}`;
const open = await api('GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls?state=open&head=${encodeURIComponent(head)}`);
if (open.length) {
  console.log(`PR already open: ${open[0].html_url}`);
  process.exit(0);
}

const body = [
  `Adds **${OWNER}/${REPO}** to \`data/plugins/${path.basename(ENTRY_PATH)}\`.`,
  '',
  'It adds a ChatGPT-style right-click menu to links and file references inside DSH desktop messages:',
  '',
  '- web links — copy address, open in the default browser;',
  '- file references — open with the default app, reveal in the file manager, copy path, copy file name;',
  '- relative references such as `src/main.ts` are resolved against the DSH workspaces before opening.',
  '',
  'Left-click behaviour is untouched; only a genuine link or file reference gets the menu. The plugin declares',
  '`dsh.bundle` in `package.json`, ships a prebuilt tarball on the latest release, and has no runtime dependencies.',
  '',
  'Checklist:',
  '',
  '- [x] `dsh.bundle` declared in `package.json`',
  '- [x] `dsh-plugin` topic on the repository',
  '- [x] repository older than 1 day',
  '- [x] entry file only — generated READMEs left alone',
].join('\n');

if (dryRun) {
  console.log(`[dry-run] would open PR ${head} -> ${BASE}\n\n${body}`);
  process.exit(0);
}

const pr = await api('POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls`, {
  title: PR_TITLE,
  head,
  base: BASE,
  body,
});
console.log(`PR opened: ${pr.html_url}`);
