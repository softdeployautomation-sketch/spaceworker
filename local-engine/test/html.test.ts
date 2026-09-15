import { test } from "node:test";
import assert from "node:assert/strict";
import {
  htmlToText,
  extractAnchors,
  scanHtml,
  findContactLinks,
  findEmbeddedPdfLinks,
  absoluteUrl,
  netlocOf,
  decodeDdgUrl,
} from "../src/html";

test("htmlToText strips tags, joins with spaces, skips script/style/head", () => {
  const html =
    '<html><head><title>X</title></head><body><h1>Acme Roofing</h1>' +
    '<p>Call <a href="mailto:sales@acme.co">Sales</a> today.</p>' +
    "<script>var x=1;</script><style>.a{color:red}</style><noscript>junk</noscript></body></html>";
  assert.equal(htmlToText(html), "Acme Roofing Call Sales today.");
});

test("extractAnchors returns only href-bearing anchors with decoded href + text", () => {
  const anchors = extractAnchors(
    '<a href="https://acme.co/contact">Contact</a> <a>no href</a> <a href="/p?a=1&amp;b=2">x</a>',
  );
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].href, "https://acme.co/contact");
  assert.equal(anchors[0].text, "Contact");
  assert.equal(anchors[1].href, "/p?a=1&b=2");
});

test("findContactLinks returns same-domain keyword links, resolved + deduped, capped", () => {
  const html =
    '<a href="/contact">Contact</a>' +
    '<a href="https://other.com/about">Their About</a>' +
    '<a href="/team">Our Team</a>' +
    '<a href="/blog">Blog</a>' +
    '<a href="/contact-us">Extra</a>'; // keyword in text/href too
  const links = findContactLinks(html, "https://acme.co", 3);
  assert.deepEqual(links, [
    "https://acme.co/contact",
    "https://acme.co/team",
    "https://acme.co/contact-us",
  ]);
});

test("findContactLinks matches keyword in link text even when href has none", () => {
  const html = '<a href="/people2">Meet the team</a>';
  assert.deepEqual(findContactLinks(html, "https://acme.co"), ["https://acme.co/people2"]);
});

test("findEmbeddedPdfLinks resolves .pdf links, strips query for detection, and caps", () => {
  const html =
    '<a href="/reports/a.pdf">A</a>' +
    '<a href="https://elsewhere.org/b.pdf?x=1">B</a>' +
    '<a href="/reports/c.pdf">C</a>' +
    '<a href="/docs/d.pdf">D</a>' +
    '<a href="/page.html">HTML</a>';
  const links = findEmbeddedPdfLinks(html, "https://acme.co", 3);
  assert.deepEqual(links, [
    "https://acme.co/reports/a.pdf",
    "https://elsewhere.org/b.pdf?x=1",
    "https://acme.co/reports/c.pdf",
  ]);
});

test("absoluteUrl resolves relative and protocol-relative URLs", () => {
  assert.equal(absoluteUrl("contact", "https://acme.co/team/"), "https://acme.co/team/contact");
  assert.equal(absoluteUrl("//cdn.acme.co/x", "https://acme.co"), "https://cdn.acme.co/x");
  assert.equal(absoluteUrl("https://x.io/p", "https://acme.co"), "https://x.io/p");
});

test("netlocOf lowercases host and drops port", () => {
  assert.equal(netlocOf("https://ACME.co:8080/x"), "acme.co");
  assert.equal(netlocOf("not a url"), "");
});

test("decodeDdgUrl unwraps DDG redirect links", () => {
  assert.equal(
    decodeDdgUrl("https://html.duckduckgo.com/l/?uddg=https%3A%2F%2Facme.co%2F"),
    "https://acme.co/",
  );
  assert.equal(decodeDdgUrl("https://acme.co/direct"), "https://acme.co/direct");
});

test("does NOT record tag-like strings inside <script>/<style> as real anchors", () => {
  // Exact reviewer repro: an <a href>-looking substring inside a JS string literal.
  const html =
    '<script>\n  var config = { template: "<a href=\\"mailto:fake@evil.com\\">Contact Team</a>" };\n</script>';
  assert.deepEqual(scanHtml(html).anchors, []);
  assert.deepEqual(extractAnchors(html), []);
  assert.equal(htmlToText(html), "");

  // Same for a <style> block and a JSON-LD <script type="application/ld+json">.
  const styleHtml = "<style>.x::after{content:'<a href=\"/contact\">'}</style>";
  assert.deepEqual(scanHtml(styleHtml).anchors, []);
});

test("findContactLinks ignores same-domain anchor-looking strings inside script templates", () => {
  // Even a same-domain, keyword-matching fake href inside inline templating must be
  // ignored — it is not a real DOM anchor.
  const html =
    '<h1>Real Heading</h1><script>var tpl = "<a href=\\"/contact\\">Team</a>";</script>';
  assert.deepEqual(findContactLinks(html, "https://acme.co"), []);
});

test("findEmbeddedPdfLinks ignores .pdf-looking hrefs inside JSON-LD/script", () => {
  const html =
    '<script type="application/ld+json">{"url":"<a href=\\"/reports/roster.pdf\\">A</a>"}</script>';
  assert.deepEqual(findEmbeddedPdfLinks(html, "https://acme.co"), []);
});

test("scanHtml still records genuine anchors and real contact links in normal markup", () => {
  const html = '<a href="/contact">Contact</a><script>var t="<a href=\\"/contact\\">x</a>"</script>';
  assert.deepEqual(scanHtml(html).anchors, [{ href: "/contact", text: "Contact" }]);
  assert.deepEqual(findContactLinks(html, "https://acme.co"), ["https://acme.co/contact"]);
});