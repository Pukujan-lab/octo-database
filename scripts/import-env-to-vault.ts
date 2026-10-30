/**
 * Owner-run import of `.env` files into a principal's vault.
 *
 * Reads `LABEL=value` lines on stdin (so values never land in argv or on
 * disk), seals each value the way the vault routes do, and adds the labels
 * the principal does not already have. Existing labels are left alone, so a
 * re-run only adds what is new. `export ` prefixes, comments and surrounding
 * quotes are handled.
 *
 * Usage (on the host, inside the API container):
 *   cat a.env b.env | docker exec -i octo-api npx tsx scripts/import-env-to-vault.ts \
 *     --principal <uuid|email> [--source <name>] [--dry-run]
 *
 * Runs on the SERVICE pool: an import has no caller principal.
 * Exit 0 = applied (or dry run), 2 = misconfigured.
 */

import { randomUUID } from 'node:crypto';
import { encryptSecret } from '../src/lib/mfa';
import { parseBulkVaultLine } from '../src/lib/vault-policy';
import { queryService, servicePool } from '../src/server/db';

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function resolvePrincipal(): Promise<string | null> {
  const target = argument('--principal');
  if (!target) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
    return target;
  }
  const rows = await queryService<{ id: string }>('SELECT id FROM octo.principals WHERE email = $1', [target]);
  return rows[0]?.id ?? null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** `export A="x"` -> `A=x`; blank lines and comments -> null. Last value for a label wins. */
function envLines(text: string): string[] {
  const byLabel = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('=');
    if (sep <= 0) continue;
    const label = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) {
      value = value.slice(1, -1);
    }
    if (value) byLabel.set(label, value);
  }
  return Array.from(byLabel, ([label, value]) => `${label}=${value}`);
}

async function main(): Promise<number> {
  const principalId = await resolvePrincipal();
  if (!principalId) {
    console.error('import-env-to-vault: pass --principal <uuid|email> for an existing principal.');
    return 2;
  }
  const dryRun = process.argv.includes('--dry-run');
  const source = argument('--source');

  const existing = new Set(
    (
      await queryService<{ label: string }>(
        'SELECT label FROM octo.vault_items WHERE principal_id = $1 AND workspace_id IS NULL',
        [principalId]
      )
    ).map((row) => row.label)
  );

  let added = 0;
  let skipped = 0;
  for (const line of envLines(await readStdin())) {
    const parsed = parseBulkVaultLine(line);
    if (!parsed.ok) {
      console.log(`refused: ${line.slice(0, line.indexOf('='))} (${parsed.error})`);
      continue;
    }
    const item = parsed.value;
    if (existing.has(item.label)) {
      skipped += 1;
      continue;
    }
    existing.add(item.label);
    added += 1;
    console.log(`${dryRun ? 'would add' : 'added'}: ${item.label} (${item.kind})`);
    if (dryRun) continue;
    await queryService(
      `INSERT INTO octo.vault_items (
         id, principal_id, workspace_id, label, description, kind, kind_source, username, url, url_kind, secret_encrypted, notes_encrypted
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
      [
        randomUUID(),
        principalId,
        item.label,
        source ? `${item.label} (from ${source})` : item.description,
        item.kind,
        item.kindSource,
        item.username,
        item.url,
        item.urlKind,
        encryptSecret(item.secret!),
      ]
    );
  }

  console.log(`\n${dryRun ? 'Would add' : 'Added'} ${added}; ${skipped} already in the vault.`);
  return 0;
}

main()
  .then(async (code) => {
    await servicePool.end();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    await servicePool.end();
    process.exit(1);
  });
