import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLeadPage, leadsFromPageText, extractLeadPdf, defaultFetcher, type CrawlDeps } from "../src/crawl";
import { type SearchResult } from "../src/lead";

function fakeFetcher(map: Record<string, string>): CrawlDeps {
  return {
    async fetchHtml(url) {
      return map[url] ?? ""; // missing → "" (unreachable page)
    },
  };
}

const result: SearchResult = { title: "Acme | Contact", url: "https://acme.co/", snippet: "" };

test("extracts leads from emails on the main page", async () => {
  const leads = await extractLeadPage(result, {
    fetcher: fakeFetcher({ "https://acme.co/": "<p>Sales at sales@acme.co</p>" }),
  });
  assert.equal(leads.length, 1);
  assert.equal(leads[0].email, "sales@acme.co");
});

test("returns no leads when the page is unreachable (Task 13 — no snippet guesses)", async () => {
  const leads = await extractLeadPage(result, { fetcher: fakeFetcher({}) });
  assert.deepEqual(leads, []);
});

test("follows same-domain contact sub-pages and folds their text in (Task 18)", async () => {
  const leads = await extractLeadPage(result, {
    fetcher: fakeFetcher({
      "https://acme.co/": '<a href="/contact">ManageTeam</a>',
      "https://acme.co/contact": "<p>Owner: janedoe@acme.co</p>",
    }),
  });
  assert.equal(leads.length, 1);
  assert.equal(leads[0].email, "janedoe@acme.co");
});

test("extracts mailto: emails from the main page's HTML", async () => {
  const leads = await extractLeadPage(result, {
    fetcher: fakeFetcher({
      "https://acme.co/": '<a href="mailto:bill@acme.co">Email us</a>',
    }),
  });
  assert.equal(leads.length, 1);
  assert.equal(leads[0].email, "bill@acme.co");
});

test("folds embedded-PDF text in when a fetchPdfText hook is provided (Task 17)", async () => {
  const fetcher: CrawlDeps = {
    async fetchHtml() {
      return '<a href="/reports/roster.pdf">Roster</a>';
    },
    async fetchPdfText() {
      return "member@roster.org\nDirector list";
    },
  };
  const leads = await extractLeadPage(result, { fetcher });
  assert.equal(leads.length, 1);
  assert.equal(leads[0].email, "member@roster.org");
});

test("reports live steps via onStep (Task 14 channel)", async () => {
  const steps: string[] = [];
  await extractLeadPage(result, {
    fetcher: fakeFetcher({
      "https://acme.co/": '<a href="/contact">Team</a>',
      "https://acme.co/contact": "<p>a@b.co</p>",
    }),
    onStep: (m) => steps.push(m),
  });
  assert.equal(steps.length, 2);
  assert.ok(steps[0].includes("Found 1 contact page(s)"));
  assert.ok(steps[1].includes("Visiting contact page"));
});

test("defaultFetcher returns '' for a non-network URL instead of throwing", async () => {
  const html = await defaultFetcher().fetchHtml("not-a-real-url");
  assert.equal(html, "");
});

test("extractLeadPdf produces leads from a PDF's extracted text (mirrors extract_lead_pdf)", async () => {
  const leads = await extractLeadPdf(result, {
    fetchPdfText: async () => "Owner: ceo@acme.co\nboard@acme.co",
  });
  assert.equal(leads.length, 2);
  // extractEmails returns a sorted, deduped set.
  assert.equal(leads[0].email, "board@acme.co");
  assert.equal(leads[1].email, "ceo@acme.co");
});

test("extractLeadPdf yields zero leads when no PDF text could be extracted", async () => {
  const leads = await extractLeadPdf(result, { fetchPdfText: async () => "" });
  assert.deepEqual(leads, []);
});

test("leadsFromPageText runs the shared post-extraction pipeline directly", () => {
  const leads = leadsFromPageText(
    result,
    "Contact: Alice Brown <a@x.co> or bob@y.co",
  );
  assert.equal(leads.length, 2);
  assert.equal(leads[0].email, "a@x.co");
  assert.equal(leads[1].email, "bob@y.co");
});