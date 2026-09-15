// Minimal, valid single-page PDF for tests: build a PDF that pdfjs-dist can parse,
// with a single text line. Offsets are computed as the file is assembled so the
// xref table is correct. ASCII-only content (safe for byte-length == char-length).

export function buildMinimalPdf(text: string): string {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    { n: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { n: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    {
      n: 3,
      body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    },
    { n: 4, body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream` },
    { n: 5, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ];

  let out = "%PDF-1.4\n";
  const offsets: Record<number, number> = {};
  for (const o of objs) {
    offsets[o.n] = out.length;
    out += `${o.n} 0 obj\n${o.body}\nendobj\n`;
  }

  const xrefOffset = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return out;
}

/** UTF-8 bytes of a built minimal PDF. */
export function pdfBytes(text: string): Uint8Array {
  return new TextEncoder().encode(buildMinimalPdf(text));
}