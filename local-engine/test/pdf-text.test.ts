import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPdfText, parsePdfTextWithPdfjs, defaultPdfTextDeps } from "../src/pdf-text";
import { pdfBytes } from "./_pdf-fixture";

function deps(fetchBytes: (url: string) => Promise<Uint8Array>, parse?: (b: Uint8Array) => Promise<string>) {
  return {
    fetchBytes,
    parsePdfText: parse ?? (async (b) => `parsed:${b.length}`),
  };
}

test("fetchPdfText returns the parser result on success", async () => {
  const out = await fetchPdfText("https://a.co/x.pdf", deps(async () => new Uint8Array(3)));
  assert.equal(out, "parsed:3");
});

test("fetchPdfText returns '' on empty bytes (unreachable / empty response)", async () => {
  const out = await fetchPdfText("https://a.co/x.pdf", deps(async () => new Uint8Array(0)));
  assert.equal(out, "");
});

test("fetchPdfText returns '' when the fetch or parser throws", async () => {
  assert.equal(await fetchPdfText("x", deps(async () => { throw new Error(); })), "");
  assert.equal(
    await fetchPdfText("x", deps(async () => new Uint8Array(2), async () => { throw new Error("encrypted"); })),
    "",
  );
});

test("fetchPdfText handles a null parser result as ''", async () => {
  const out = await fetchPdfText("x", deps(async () => new Uint8Array(2), async () => null as unknown as string));
  assert.equal(out, "");
});

test("parsePdfTextWithPdfjs extracts text from a real PDF (pdfjs-dist, lazy-loaded)", async () => {
  const bytes = pdfBytes("member@roster.org");
  const text = await parsePdfTextWithPdfjs(bytes);
  assert.ok(text.includes("member@roster.org"), `expected email in extracted text, got: ${text}`);
});

test("fetchPdfText wires the real pdfjs parser to an injected bytes source", async () => {
  const bytes = pdfBytes("jane@acme.co");
  const text = await fetchPdfText("https://a.co/r.pdf", {
    fetchBytes: async () => bytes,
    parsePdfText: parsePdfTextWithPdfjs,
  });
  assert.ok(text.includes("jane@acme.co"));
  // Multiple lines still flow through as one blob (per-page join).
  const multi = await fetchPdfText("https://a.co/r.pdf", {
    fetchBytes: async () => pdfBytes("a@x.co\nb@y.co"),
    parsePdfText: parsePdfTextWithPdfjs,
  });
  assert.ok(multi.includes("a@x.co") && multi.includes("b@y.co"));
});

test("defaultPdfTextDeps returns the pdfjs parser wired to a bytes fetcher", () => {
  const d = defaultPdfTextDeps();
  assert.equal(d.parsePdfText, parsePdfTextWithPdfjs);
  assert.equal(typeof d.fetchBytes, "function");
});

test("parsePdfTextWithPdfjs returns '' for empty / corrupt input", async () => {
  assert.equal(await parsePdfTextWithPdfjs(new Uint8Array(0)), "");
  assert.equal(await parsePdfTextWithPdfjs(new TextEncoder().encode("definitely not a pdf")), "");
});