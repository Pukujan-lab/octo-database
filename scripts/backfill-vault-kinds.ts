/**
 * One-off backfill for imported vault keys (PDD 2026-10-17).
 *
 * The bulk import used to stamp every line with one batch kind (default
 * `token`), so a `.env` paste of 171 keys arrived all-token with no URL. This
 * re-derives each row's kind from its label and value, fills the URL column
 * when the value is itself an address, and marks the row
 * kind_source='inferred' so the health pass never probes it.
 *
 * Usage (on the host, with the service connection):
 *   OCTO_SERVICE_URL=... npx tsx scripts/backfill-vault-kinds.ts \
 *     --principal <uuid|email> [--dry-run]
 *
 * Runs on the SERVICE pool: a backfill has no caller principal.
 * Exit 0 = applied (or dry run), 2 = misconfigured. Idempotent: after one run
 * no explicit rows remain for that principal, so a re-run reports 0.
 */

import { inferVaultKind } from '../src/lib/vault-policy';
import { decryptSecret } from '../src/lib/mfa';
import { queryService, servicePool } from '../src/server/db';

interface Row {
  id: string;
  label: string;
  kind: string;
  url: string | null;
  secretEncrypted: string | null;
}

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
  const rows = await queryService<{ id: string }>(
    'SELECT id FROM octo.principals WHERE email = $1',
    [target]
  );
  return rows[0]?.id ?? null;
}

async function main(): Promise<number> {
  const principalId = await resolvePrincipal();
  if (!principalId) {
    console.error('backfill-vault-kinds: pass --principal <uuid|email> for an existing principal.');
    return 2;
  }
  const dryRun = process.argv.includes('--dry-run');

  const rows = await queryService<Row>(
    `SELECT id,
            label,
            kind,
            url,
            secret_encrypted AS "secretEncrypted"
     FROM octo.vault_items
     WHERE principal_id = $1 AND kind_source = 'explicit'
     ORDER BY label`,
    [principalId]
  );

  let changed = 0;
  for (const row of rows) {
    let secret = '';
    try {
      secret = row.secretEncrypted ? decryptSecret(row.secretEncrypted) ?? '' : '';
    } catch {
      // A row sealed with a different OCTO_MFA_SECRET cannot be read here; the
      // label alone is still enough to infer a kind.
    }
    const kind = inferVaultKind(row.label, secret) ?? row.kind;
    const url = kind === 'url' && !row.url && /^https?:\/\//i.test(secret) ? secret : row.url;
    if (kind !== row.kind) changed += 1;
    if (!dryRun) {
      await queryService(
        `UPDATE octo.vault_items
         SET kind = $2, kind_source = 'inferred', url = $3, updated_at = now()
         WHERE id = $1`,
        [row.id, kind, url]
      );
    }
    if (kind !== row.kind) console.log(`${row.label}: ${row.kind} -> ${kind}`);
  }

  console.log(
    `\n${dryRun ? 'Would mark' : 'Marked'} ${rows.length} rows inferred; ${changed} kind changes.`
  );
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
