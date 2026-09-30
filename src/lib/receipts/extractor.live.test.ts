import { describe, expect, it } from 'vitest';

import { createClaudeExtractor } from './extractor';

/**
 * The one test that calls the real model. It runs only with RUN_AI_INTEGRATION=1 (and a key in
 * the environment); a normal run shows it as skipped. It exists because the stubbed-fetch tests
 * cannot notice when the provider starts rejecting a parameter we send.
 */

/** A well-formed one-page PDF whose only text is "Total 41.10", with a correct xref table. */
function tinyReceiptPdf(): Uint8Array {
  const stream = 'BT /F1 18 Tf 20 50 Td (Total 41.10) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe.skipIf(process.env.RUN_AI_INTEGRATION !== '1')('the real receipt model', () => {
  it('reads the total off a small PDF', { timeout: 60_000 }, async () => {
    const receipt = await createClaudeExtractor().extract({
      bytes: tinyReceiptPdf(),
      mediaType: 'application/pdf',
      accounts: [],
    });

    expect(receipt.legible).toBe(true);
    expect(receipt.totalCents).toBe(4110);
  });
});
