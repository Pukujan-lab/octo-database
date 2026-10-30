import { describe, expect, it } from 'vitest';
import { otslTableRows, passages, unknownNumbers } from '../../src/rag/passages';

describe('Reader passages (#365)', () => {
  it('keeps each table row on one line and repeats the header when a table is split', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `<tr><td>Status ${i}</td><td>${10_000 + i}</td></tr>`).join('');
    const md = `## Filing requirements\n\n<table><tr><th>Filing status</th><th>Amount</th></tr>${rows}</table>`;
    const out = passages(md, 9, 200);

    expect(out.length).toBeGreaterThan(1);
    for (const p of out) {
      expect(p.page).toBe(9);
      expect(p.text.startsWith('Filing requirements\nFiling status | Amount')).toBe(true);
    }
    expect(out.map((p) => p.text).join('\n')).toContain('Status 29 | 10029');
  });

  it('reads OTSL and Markdown pipe tables', () => {
    expect(otslTableRows('<otsl><ched>Status<ched>Amount<nl><fcel>Single<fcel>14,600<nl></otsl>')).toEqual([
      'Status | Amount',
      'Single | 14,600',
    ]);
    const md = '| Status | Amount |\n|---|---|\n| Single | 14,600 |';
    expect(passages(md, 1)[0]!.text).toBe('Status | Amount\nSingle | 14,600');
  });

  it('keeps whole-page OCR rows apart, column gaps as " | "', () => {
    const md = 'Table 1. Standard Deduction\nFiling status        Amount\nSingle        $14,600\nHead of household     $21,900';
    expect(passages(md, 3)[0]!.text).toBe(
      'Table 1. Standard Deduction\nFiling status | Amount\nSingle | $14,600\nHead of household | $21,900'
    );
  });

  it('flags numbers the page text layer does not contain', () => {
    expect(unknownNumbers('Single | 14,600', 'Single   14600')).toEqual([]);
    expect(unknownNumbers('Single | 14,800', 'Single   14,600')).toEqual(['14,800']);
  });
});
