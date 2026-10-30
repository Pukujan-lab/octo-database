#!/usr/bin/env node
/**
 * Pull secrets from the Octo vault into a `.env` file (issue #361).
 *
 * The vault is the source; the file is a generated cache that existing tools keep
 * reading. The file's own assignment lines name which labels it holds, so a
 * re-run refreshes those values. A block between `# >>> local` and
 * `# <<< local` is copied through unchanged and is never pulled: it holds the
 * agent key that authenticates the pull and anything that must stay
 * machine-specific.
 *
 * Usage:
 *   OCTO_AGENT_KEY=... node scripts/octo-env-pull.mjs --out ~/.hack_env
 *   node scripts/octo-env-pull.mjs --out FILE --add NEW_LABEL     # add a label, then pull
 *   node scripts/octo-env-pull.mjs --out FILE --all               # every env-shaped vault label
 *   node scripts/octo-env-pull.mjs --out FILE --check             # list labels whose value differs (names only)
 *   node scripts/octo-env-pull.mjs --only A,B                     # print KEY=value lines to stdout
 *
 * The key is read from OCTO_AGENT_KEY, or from the local block of --out. It must
 * be an owner agent key (listed in OCTO_OWNER_AGENT_KEYS on the server).
 * OCTO_URL overrides the server (default https://octodb.design-bakery.com).
 * Exit 0 = written / no differences, 1 = differences found (--check), 2 = error.
 */

import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCAL_START = '# >>> local';
const LOCAL_END = '# <<< local';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}
const flag = (name) => process.argv.includes(name);

function parseLine(raw) {
  const line = raw.trim().replace(/^export\s+/, '');
  if (!line || line.startsWith('#')) return null;
  const sep = line.indexOf('=');
  if (sep <= 0) return null;
  const label = line.slice(0, sep).trim();
  if (!LABEL.test(label)) return null;
  let value = line.slice(sep + 1).trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
    value = value.slice(1, -1);
  }
  return { label, value };
}

/** Splits a file into its local block (verbatim) and the labels of its other lines. */
function readEnvFile(path) {
  const local = [];
  const labels = [];
  const values = new Map();
  if (!path || !existsSync(path)) return { local, labels, values };
  let inLocal = false;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (raw.trim() === LOCAL_START) inLocal = true;
    if (inLocal) local.push(raw);
    const parsed = parseLine(raw);
    if (parsed) {
      values.set(parsed.label, parsed.value);
      if (!inLocal && !labels.includes(parsed.label)) labels.push(parsed.label);
    }
    if (raw.trim() === LOCAL_END) inLocal = false;
  }
  return { local, labels, values };
}

/** Single-quoted shell value: safe for `source`, docker env_file reads it literally only if unquoted, so quote only when needed. */
function formatValue(value) {
  return /^[A-Za-z0-9_@%+=:,./-]*$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

async function api(base, key, path) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'octo-env-pull/1' },
  });
  if (!res.ok) throw new Error(`${path.split('/').slice(0, 4).join('/')} -> ${res.status}`);
  return res.json();
}

async function main() {
  const out = arg('--out');
  const file = readEnvFile(out);
  const localLabels = new Set(file.local.map(parseLine).filter(Boolean).map((p) => p.label));
  const key = process.env.OCTO_AGENT_KEY || (localLabels.has('OCTO_AGENT_KEY') ? file.values.get('OCTO_AGENT_KEY') : '');
  if (!key) {
    console.error('octo-env-pull: set OCTO_AGENT_KEY or keep it in the file\'s local block.');
    return 2;
  }
  const base = (process.env.OCTO_URL || 'https://octodb.design-bakery.com').replace(/\/+$/, '');

  const { items } = await api(base, key, '/api/vault/items');
  const byLabel = new Map(items.filter((i) => !i.workspaceId && i.hasSecret).map((i) => [i.label, i]));

  let wanted;
  if (arg('--only')) wanted = arg('--only').split(',').map((s) => s.trim()).filter(Boolean);
  else if (flag('--all')) wanted = [...byLabel.keys()].filter((l) => LABEL.test(l)).sort();
  else wanted = [...file.labels];
  const add = arg('--add');
  if (add) for (const l of add.split(',').map((s) => s.trim())) if (l && !wanted.includes(l)) wanted.push(l);
  wanted = wanted.filter((l) => !localLabels.has(l));

  const missing = wanted.filter((l) => !byLabel.has(l));
  const values = new Map();
  const queue = wanted.filter((l) => byLabel.has(l));
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let l = queue.shift(); l; l = queue.shift()) {
        const { item } = await api(base, key, `/api/vault/items/${byLabel.get(l).id}`);
        values.set(l, item.secret ?? '');
      }
    })
  );

  if (flag('--check')) {
    const differ = [...values].filter(([l, v]) => file.values.has(l) && file.values.get(l) !== v).map(([l]) => l);
    console.log(JSON.stringify({ checked: values.size, differ, notInVault: missing }));
    return differ.length || missing.length ? 1 : 0;
  }

  // A label the vault lacks keeps its current value so a pull never drops a setting.
  const lines = [];
  for (const l of wanted) {
    if (values.has(l)) lines.push(`${l}=${formatValue(values.get(l))}`);
    else if (file.values.has(l)) lines.push(`${l}=${formatValue(file.values.get(l))}`);
  }

  if (!out) {
    process.stdout.write(lines.join('\n') + '\n');
  } else {
    const local = file.local.length ? file.local : [LOCAL_START, LOCAL_END];
    const text = [
      '# Generated by octo-env-pull from the Octo vault. Edit secrets in the vault, not here;',
      '# the next pull overwrites everything outside the local block.',
      ...local,
      '',
      ...lines,
      '',
    ].join('\n');
    if (existsSync(out)) copyFileSync(out, `${out}.prev`);
    writeFileSync(`${out}.tmp`, text, { mode: 0o600 });
    renameSync(`${out}.tmp`, out);
    chmodSync(out, 0o600);
  }
  console.error(`octo-env-pull: ${values.size} from the vault${missing.length ? `, not in the vault (kept): ${missing.join(', ')}` : ''}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('octo-env-pull failed:', err instanceof Error ? err.message : err);
    process.exit(2);
  }
);
