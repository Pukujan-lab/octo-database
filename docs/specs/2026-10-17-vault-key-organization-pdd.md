# PDD — Vault key organization: inferred kinds, service groups, group sidebar

**Status:** draft for owner review, 2026-10-17.
**Owning context:** issue #251 (Keys dashboard UX) and issue #92 (secret storage). Follows PR #266 (ABA-generated key table).

## User / actor

The owner browsing their own vault — currently 171 keys bulk-imported from `.env` files into the account cabinet.

## Job

Find and understand any stored key at a glance: what service it belongs to, what kind of thing it is (a URL, a token, a plain config value), and move between services without scrolling 171 rows.

## Why

The bulk import takes **one kind per paste** and defaults it to `token` (`parseBulkVaultLine`, `src/lib/vault-policy.ts:263`), so all 171 imported rows have `kind='token'` and a null `url`. The Kind column shows "token" on every row — it carries no information. The flat table also hides the obvious structure: the labels are machine-shaped (`SERVICE_FIELDNAME`), so the vendor/service and the value type are already in the data. Nothing should have to be re-typed by hand.

## Design (inferred from how the keys are saved)

### 1. Kind inference

A key's kind is inferred from its label and value, per line, at import and at single save:

| Pattern on the label (case-insensitive) | Kind |
| --- | --- |
| ends with `_URL`, `_ENDPOINT`, `_HOST`, `_BASE_URL`, or contains `-api-url` / `-base-url` | `url` |
| ends with `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `_ACCESS_KEY`, or contains `-token` / `-api-key` | `token` |
| anything else (`*_MODEL`, `*_USER`, `*_MODE`, `*_REF`…) | `note` |

For a `url`-kind line whose value is itself an `http(s)://` string, the URL column is filled from the value. Explicit per-line override stays possible in the bulk paste with a `kind:` prefix (`url:FISH_AUDIO_BASE_URL=https://…`); without a prefix, inference decides. The one-selector-per-paste default is retired.

### 2. One-time backfill

The same inference runs once over existing rows on the live instance, correcting the 171 `token` rows and populating the `url` column where the label says URL and the stored secret is an `http(s)://` value. The backfill is a one-off script (never re-runs automatically), reports what it changed, and never touches secrets, grants, or leases.

### 3. Service groups

Keys group by **service**: the label prefix before the first `_` / `-` field-name segment (`OPENROUTER_API_KEY` → OpenRouter, `CKFF_CORTEX_DEFAULT_MODEL` → ckff-cortex, `octo_db_chatgpt_api_key` → octo-db). Normalization: case-insensitive, `CLOUDFLARE_R2_*` folds into the Cloudflare group. A group with one key still renders as a group so the shape is stable. A key whose label has no recognizable prefix (e.g. `vast-ai`) forms its own group from the whole label.

### 4. Grouped rendering + sidebar

The table renders as collapsible group sections (dropdown-style header with the service name and its key count, expand/collapse, expand-all/collapse-all). A **sidebar to the left of the table** lists the groups as a navigation index: click a group to expand and scroll to it; the free-text search narrows both the groups and the rows inside them. On narrow widths the sidebar collapses above the table as a horizontal chip row.

## Failure boundary (must-handle)

The health pass re-probes items every run, and for `kind='url'` a 404/410 marks the row `stale` (`src/lib/vault-health.ts:83`); a row `stale` for 14 days is **deleted** by the next pass (`dbPurgeStaleVaultItems`, `src/server/db.ts:2739`). Most `*_URL` rows store the URL as the *secret value* (`LABEL=https://…`), and vendor base URLs commonly 404 to a bare HEAD probe. So reclassifying a config row to `url` kind must not arm that auto-purge against the owner's stored keys — a 404 on a config URL is not evidence the key is dead.

The change therefore adds one marker column, `octo.vault_items.kind_source` (`'explicit'` default, `'inferred'` when set by inference/backfill). The health pass skips probing `kind_source='inferred'` rows entirely — their health stays `unchecked`, they can never become `stale`, and they are never auto-purged. Live URL probing and the stale→purge path keep working exactly as today for explicitly saved rows. No other purge semantics change; the pass itself remains on-demand only.

## In scope

- Kind inference in the bulk-import and single-save parse path (server, `src/lib/vault-policy.ts`).
- One-time backfill script for existing rows + running it on the live instance, display-only per the failure boundary (reclassify Kind, populate `url` column, leave health `unchecked` and exempt from purge).
- Grouping and grouped rendering of the key table (ABA-generated UI, integrated into `frontend/src/views/VaultView.tsx`).
- Group-navigation sidebar (ABA-generated UI).
- Health/sort/filter behavior preserved on the grouped table.

## Out of scope

- Editing the vault API's grant/lease/relay behavior.
- Any schema change beyond one marker column (`kind_source`) so the health pass can leave inferred rows unprobed.
- Re-parenting items into cabinets by service; grouping is derived from labels at render time, not stored.
- Any redesign of pages other than Keys.

## Reuse

- Existing `VAULT_KINDS`, `parseBulkVaultLine`, `parseVaultItem` (extended, not replaced).
- Existing e2e hooks (`vault-account-*`, `view-vault`, bulk testids) preserved so the Playwright suite holds.
- ABA headless engine for all UI work, per standing direction.

## Observable success

- After backfill, the live cabinet shows a mix of kinds (`url` for the `*_URL` rows, `note` for config rows, `token` for credentials) and the URL column is populated for URL rows — with no row auto-purged by the health pass as a result.
- The table groups under service headers (OpenRouter, Cloudflare, ckff-cortex, Prometheus, …), each collapsible, with the sidebar index jumping between them.
- A fresh bulk paste produces correctly inferred kinds per line with one confirmation code for the batch.
- `gates` green; vault e2e suite passes; live instance serves the new table.
