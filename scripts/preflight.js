// scripts/preflight.js — runs before every deploy/push.
//
// Catches the failure modes that would otherwise only surface after pm2
// has crash-looped 10 times and given up. Cheap insurance, no API calls.
//
// Run:  npm run preflight
//
// Exits non-zero on any failure so it can be wired into a pre-push hook
// or a deploy script later without extra plumbing.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];

function pass(name)            { checks.push({ name, ok: true }); }
function fail(name, reason)    { checks.push({ name, ok: false, reason }); failures.push(`${name}: ${reason}`); }

// ─── 1. Syntax-check every JS file we own ──────────────────────────────────
// node --check catches typos, missing brackets, etc. before runtime.
function syntaxCheck(file) {
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe' });
    pass(`syntax: ${path.relative(ROOT, file)}`);
  } catch (err) {
    fail(`syntax: ${path.relative(ROOT, file)}`, err.stderr?.toString().trim() || err.message);
  }
}

function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

for (const f of walkJs(ROOT)) syntaxCheck(f);

// ─── 2. config.js imports cleanly and has the expected shape ───────────────
try {
  const cfg = await import(pathToFileURL(path.join(ROOT, 'config.js')).href);
  const { TEAM, TEAM_IDS, TEAM_ID_BY_NAME, BREEZ_TEAM_TELEGRAM_IDS, TELEGRAM_ID_TO_NAME,
          ASSISTANT_CHANNEL_ID, ALLOWED_POST_CHANNELS, BOT_USER_ID } = cfg;

  if (!TEAM || typeof TEAM !== 'object') throw new Error('TEAM missing or not an object');
  if (!ASSISTANT_CHANNEL_ID || !/^C[A-Z0-9]+$/.test(ASSISTANT_CHANNEL_ID)) throw new Error(`ASSISTANT_CHANNEL_ID malformed: ${ASSISTANT_CHANNEL_ID}`);
  if (!BOT_USER_ID || !/^U[A-Z0-9]+$/.test(BOT_USER_ID)) throw new Error(`BOT_USER_ID malformed: ${BOT_USER_ID}`);
  if (!(ALLOWED_POST_CHANNELS instanceof Set) || ALLOWED_POST_CHANNELS.size === 0) throw new Error('ALLOWED_POST_CHANNELS must be a non-empty Set');

  for (const [id, member] of Object.entries(TEAM)) {
    if (!/^U[A-Z0-9]+$/.test(id)) throw new Error(`TEAM key "${id}" is not a Slack user ID (must start with U)`);
    if (!member?.name || typeof member.name !== 'string') throw new Error(`TEAM[${id}].name missing`);
    if (!member?.handles || typeof member.handles !== 'string' || member.handles.length < 10) throw new Error(`TEAM[${id}].handles missing or too short`);
  }

  const namesFromTeam = new Set(Object.values(TEAM).map(m => m.name));
  const namesFromLookup = new Set(Object.keys(TEAM_ID_BY_NAME));
  for (const n of namesFromTeam) if (!namesFromLookup.has(n)) throw new Error(`TEAM_ID_BY_NAME missing "${n}"`);
  for (const n of namesFromLookup) if (!namesFromTeam.has(n)) throw new Error(`TEAM_ID_BY_NAME has stale name "${n}" not in TEAM`);

  for (const id of BREEZ_TEAM_TELEGRAM_IDS) {
    if (!/^\d+$/.test(id)) throw new Error(`BREEZ_TEAM_TELEGRAM_IDS contains non-numeric: ${id}`);
    if (!TELEGRAM_ID_TO_NAME[id]) throw new Error(`TELEGRAM_ID_TO_NAME missing entry for ${id}`);
  }

  pass(`config.js: ${Object.keys(TEAM).length} team members, ${BREEZ_TEAM_TELEGRAM_IDS.size} Telegram IDs — all well-formed`);
} catch (err) {
  fail('config.js', err.message);
}

// ─── 3. routing_rules.json parses if present ───────────────────────────────
const rulesPath = path.join(ROOT, 'data', 'routing_rules.json');
if (fs.existsSync(rulesPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    // Valid states:
    //   {}                           — empty starter before learner's first run
    //   { rules: [] }                — learner ran but found no refinements
    //   { rules: [...], generated_at } — learner wrote refinements
    // Invalid: anything where `rules` exists but isn't an array.
    if (data.rules !== undefined && !Array.isArray(data.rules)) {
      throw new Error('"rules" field exists but is not an array');
    }
    const count = Array.isArray(data.rules) ? data.rules.length : 0;
    const ts = data.generated_at ?? 'not yet written by learner';
    pass(`routing_rules.json: ${count} rules, generated_at=${ts}`);
  } catch (err) {
    fail('routing_rules.json', err.message);
  }
} else {
  pass('routing_rules.json: not present (fine — learner will create it)');
}

// ─── 4. package.json is valid JSON and declares "type": "module" ───────────
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.type !== 'module') throw new Error('package.json "type" must be "module"');
  if (!pkg.dependencies?.['@slack/bolt']) throw new Error('missing @slack/bolt dependency');
  if (!pkg.dependencies?.['@anthropic-ai/sdk']) throw new Error('missing @anthropic-ai/sdk dependency');
  if (!pkg.dependencies?.['better-sqlite3']) throw new Error('missing better-sqlite3 dependency');
  pass('package.json: type=module, all core deps present');
} catch (err) {
  fail('package.json', err.message);
}

// ─── Report ────────────────────────────────────────────────────────────────
const pad = (s) => s.padEnd(60);
console.log('\nPreflight checks:\n');
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${pad(c.name)}${c.ok ? '' : '— ' + c.reason}`);
}
console.log();

if (failures.length > 0) {
  console.error(`Preflight FAILED — ${failures.length} issue(s). Do not deploy.\n`);
  process.exit(1);
} else {
  console.log(`Preflight OK — ${checks.length} checks passed.\n`);
  process.exit(0);
}
