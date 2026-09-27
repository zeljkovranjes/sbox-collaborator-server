#!/usr/bin/env node
// Collaborator git hook: before a commit or push, checks the files you are about to commit/push
// against teammates' reservations on the Collaborator server.
//
// Install once per clone (from the repository root):
//   node collab-check.mjs install            # warn only (default)
//   node collab-check.mjs install --block    # refuse commits/pushes that touch others' reservations
// or download it from your server:  curl -o collab-check.mjs https://<server>/hooks/collab-check.mjs
//
// Configuration (nothing secret is written into the repository):
//   .collab.json in the repo root (commit it): { "url": "https://mcp.example.com", "project": "sailing", "mode": "warn" | "block", "root": "" }
//   COLLAB_TOKEN   your personal access key (environment variable, never in a file in the repo)
//   COLLAB_URL / COLLAB_PROJECT / COLLAB_MODE override .collab.json
//   COLLAB_ALLOW=1 lets one commit/push through anyway (or git commit --no-verify)
//
// When the server cannot be reached the hook only warns: it never stops you from working.
// Needs Node 18+ (fetch). No dependencies.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
const say = (line) => process.stderr.write(`${line}\n`);
const color = (code, text) => (process.stderr.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text);

function config(repoRoot) {
  let file = {};
  const path = join(repoRoot, '.collab.json');
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      say(color(33, 'collab: .collab.json is not valid JSON, ignoring it'));
    }
  }
  return {
    url: (process.env.COLLAB_URL || file.url || '').replace(/\/+$/, ''),
    project: process.env.COLLAB_PROJECT || file.project || '',
    mode: process.env.COLLAB_MODE || file.mode || 'warn',
    root: (file.root || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    token: process.env.COLLAB_TOKEN || '',
  };
}

/** Files in the commit being made. */
function stagedFiles() {
  const out = git('diff', '--cached', '--name-only', '--diff-filter=ACMRD', '-z');
  return out.split('\0').filter(Boolean);
}

/** Files in the commits being pushed (git passes "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin). */
function pushedFiles(stdin) {
  const files = new Set();
  const zero = /^0+$/;
  for (const line of stdin.split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || zero.test(localSha)) continue; // deleting a remote branch
    let range;
    if (remoteSha && !zero.test(remoteSha)) range = [`${remoteSha}..${localSha}`];
    else range = [localSha, '--not', '--remotes']; // new branch: commits no remote has yet
    let commits = [];
    try {
      commits = git('rev-list', ...range).split('\n').filter(Boolean);
    } catch {
      continue;
    }
    for (const sha of commits.slice(0, 500)) {
      for (const f of git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha).split('\0')) if (f) files.add(f);
    }
  }
  return [...files];
}

async function check(stage) {
  const repoRoot = git('rev-parse', '--show-toplevel');
  const cfg = config(repoRoot);
  if (!cfg.url || !cfg.project) {
    say(color(33, 'collab: no server configured (.collab.json with url + project, or COLLAB_URL/COLLAB_PROJECT) – skipping reservation check'));
    return 0;
  }
  if (!cfg.token) {
    say(color(33, 'collab: COLLAB_TOKEN is not set – skipping reservation check'));
    return 0;
  }
  const stdin = stage === 'pre-push' ? readFileSync(0, 'utf8') : '';
  let files = stage === 'pre-push' ? pushedFiles(stdin) : stagedFiles();
  if (cfg.root) files = files.filter((f) => f === cfg.root || f.startsWith(`${cfg.root}/`)).map((f) => f.slice(cfg.root.length + 1));
  if (!files.length) return 0;

  const conflicts = [];
  try {
    for (let i = 0; i < files.length; i += 200) {
      const response = await fetch(`${cfg.url}/api/tools/file_check_conflict`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', 'x-collab-client': 'git-hook' },
        body: JSON.stringify({ project: cfg.project, paths: files.slice(i, i + 200) }),
        signal: AbortSignal.timeout(6000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        say(color(33, `collab: server answered ${response.status}${body.error ? ` (${body.error.message})` : ''} – not checked`));
        return 0;
      }
      conflicts.push(...(body.result.conflicts ?? []));
    }
  } catch (error) {
    say(color(33, `collab: cannot reach ${cfg.url} (${error.message}) – not checked`));
    return 0;
  }
  if (!conflicts.length) return 0;

  const blocking = cfg.mode === 'block' && process.env.COLLAB_ALLOW !== '1';
  say('');
  say(color(blocking ? 31 : 33, `collab: ${conflicts.length} file(s) in this ${stage === 'pre-push' ? 'push' : 'commit'} are reserved by a teammate:`));
  for (const c of conflicts.slice(0, 20)) say(`  - ${c.message}`);
  if (conflicts.length > 20) say(`  … ${conflicts.length - 20} more`);
  say('');
  if (blocking) {
    say(color(31, 'collab: stopped. Coordinate with them first, or override once with COLLAB_ALLOW=1 (or --no-verify).'));
    return 1;
  }
  say(color(33, 'collab: continuing (warn mode). Tell them you changed these files.'));
  return 0;
}

function install(block) {
  const repoRoot = git('rev-parse', '--show-toplevel');
  const hooksDir = resolve(repoRoot, git('rev-parse', '--git-path', 'hooks'));
  const script = fileURLToPath(import.meta.url);
  const target = join(repoRoot, '.collab', 'collab-check.mjs');
  // Keep a copy inside the repo so the hook survives the download folder being cleaned.
  mkdirSync(dirname(target), { recursive: true });
  if (resolve(script) !== resolve(target)) copyFileSync(script, target);
  const rel = relative(repoRoot, target).replace(/\\/g, '/');
  for (const stage of ['pre-commit', 'pre-push']) {
    const hook = join(hooksDir, stage);
    const line = `node "$(git rev-parse --show-toplevel)/${rel}" check ${stage} || exit 1`;
    if (existsSync(hook) && readFileSync(hook, 'utf8').includes('collab-check.mjs')) {
      say(`collab: ${stage} hook already installed`);
      continue;
    }
    const existing = existsSync(hook) ? readFileSync(hook, 'utf8').trimEnd() : '#!/bin/sh';
    writeFileSync(hook, `${existing}\n# Collaborator: reservation check\n${line}\n`);
    try {
      chmodSync(hook, 0o755);
    } catch {
      /* Windows */
    }
    say(`collab: installed ${stage} hook`);
  }
  const cfgPath = join(repoRoot, '.collab.json');
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, `${JSON.stringify({ url: 'https://mcp.example.com', project: 'your-project-id', mode: block ? 'block' : 'warn' }, null, 2)}\n`);
    say('collab: wrote .collab.json – set url and project, then commit it (it contains no secrets)');
  }
  say('collab: set COLLAB_TOKEN to your access key in your environment (never in the repo)');
}

const [command, stage] = process.argv.slice(2);
if (command === 'install') install(process.argv.includes('--block'));
else if (command === 'check' && (stage === 'pre-commit' || stage === 'pre-push')) process.exit(await check(stage));
else {
  say('usage: node collab-check.mjs install [--block] | check <pre-commit|pre-push>');
  process.exit(2);
}
