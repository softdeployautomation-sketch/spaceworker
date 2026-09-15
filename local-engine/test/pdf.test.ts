import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPdfUrlPath,
  isPdfContentType,
  sniffPdfMagic,
  isPdfResult,
} from "../src/pdf";

const noop = { head: async () => ({}), getBytes: async () => ({}) };

test("isPdfUrlPath detects .pdf URLs, ignoring case, query strings, trailing slashes", () => {
  assert.equal(isPdfUrlPath("https://a.co/x.pdf"), true);
  assert.equal(isPdfUrlPath("https://a.co/x.PDF?v=2"), true);
  assert.equal(isPdfUrlPath("https://a.co/x.pdf/"), true);
  assert.equal(isPdfUrlPath("https://a.co/x.html"), false);
  assert.equal(isPdfUrlPath("https://a.co/x.pdfv2"), false);
});

test("isPdfContentType classifies PDF Content-Types (case/param-insensitive)", () => {
  assert.equal(isPdfContentType("application/pdf"), true);
  assert.equal(isPdfContentType("Application/PDF; charset=utf-8"), true);
  assert.equal(isPdfContentType("text/html"), false);
  assert.equal(isPdfContentType(null), false);
});

test("sniffPdfMagic checks the leading magic bytes", () => {
  assert.equal(sniffPdfMagic("%PDF-1.4"), true);
  assert.equal(sniffPdfMagic("not a pdf"), false);
});

test("isPdfResult: URL ending in .pdf short-circuits to true", async () => {
  assert.equal(await isPdfResult("https://a.co/doc.pdf", noop), true);
});

test("isPdfResult: HEAD Content-Type app/pdf → true", async () => {
  const deps = { head: async () => ({ contentType: "application/pdf" }), getBytes: async () => ({}) };
  assert.equal(await isPdfResult("https://a.co/doc", deps), true);
});

test("isPdfResult: unambiguous non-PDF HEAD answer is trusted (no GET)", async () => {
  let got = false;
  const deps = {
    head: async () => ({ contentType: "text/html" }),
    getBytes: async () => {
      got = true;
      return { contentType: "application/pdf" };
    },
  };
  assert.equal(await isPdfResult("https://a.co/doc", deps), false);
  assert.equal(got, false, "should not fall through to GET");
});

test("isPdfResult: ambiguous HEAD falls through to GET magic bytes (mislabeled/streamed)", async () => {
  const deps = {
    head: async () => ({ contentType: "application/octet-stream" }),
    getBytes: async () => ({ contentType: "application/octet-stream", bodyStart: "%PDF-1.4" }),
  };
  assert.equal(await isPdfResult("https://a.co/doc", deps), true);
});

test("isPdfResult: GET Content-Type pdf → true", async () => {
  const deps = { head: async () => ({}), getBytes: async () => ({ contentType: "application/pdf" }) };
  assert.equal(await isPdfResult("https://a.co/doc", deps), true);
});

test("isPdfResult: HEAD failure + GET neither CT nor magic → false", async () => {
  const deps = {
    head: async () => {
      throw new Error("405");
    },
    getBytes: async () => ({ contentType: "text/html" }),
  };
  assert.equal(await isPdfResult("https://a.co/doc", deps), false);
});

test("isPdfResult: everything fails → false", async () => {
  const deps = {
    head: async () => {
      throw new Error();
    },
    getBytes: async () => {
      throw new Error();
    },
  };
  assert.equal(await isPdfResult("https://a.co/doc", deps), false);
});