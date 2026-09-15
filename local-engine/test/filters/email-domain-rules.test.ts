import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseEmailDomainAllowlist,
  emailMatchesRules,
  filterLeadsByEmailDomains,
  buildSiteRestrictionClause,
  applySiteRestrictionToQuery,
  siteRestrictionTargetsOnlyPdfRareHosts,
  isEmptyRules,
} from "../../src/filters/email-domain-rules";

test("parseEmailDomainAllowlist handles comments, commas, wildcards, exacts", () => {
  const rules = parseEmailDomainAllowlist(
    "# roster domains\ngmail.com,  @yahoo.com\n*.edu\n.gov\n\nbad_line_no_dot\n",
  );
  assert.deepEqual(rules.exactDomains, ["gmail.com", "yahoo.com"]);
  assert.deepEqual(rules.suffixes, ["edu", "gov"]);
  assert.equal(isEmptyRules(rules), false);
});

test("emailMatchesRules matches exact, subdomain, and suffix hosts", () => {
  const rules = parseEmailDomainAllowlist("gmail.com\n*.edu");
  assert.ok(emailMatchesRules("user@gmail.com", rules));
  assert.ok(emailMatchesRules("user@mail.gmail.com", rules)); // subdomain of gmail.com
  assert.ok(emailMatchesRules("ut@utexas.edu", rules)); // *.edu suffix
  assert.equal(emailMatchesRules("user@yahoo.com", rules), false);
});

test("filterLeadsByEmailDomains drops non-matching leads and counts them", () => {
  const rules = parseEmailDomainAllowlist("gmail.com");
  const { kept, dropped } = filterLeadsByEmailDomains(
    [{ email: "a@gmail.com" }, { email: "b@hotmail.com" }, { email: null }, {}],
    rules,
  );
  assert.equal(kept.length, 1);
  assert.equal(dropped, 3);
});

test("empty rules are a no-op pass-through", () => {
  const leads = [{ email: "a@gmail.com" }, { email: "b@x.co" }];
  const { kept, dropped } = filterLeadsByEmailDomains(leads, null);
  assert.equal(kept.length, 2);
  assert.equal(dropped, 0);
});

test("builds a site: clause and drops search/social portals", () => {
  assert.equal(buildSiteRestrictionClause("harvard.edu, google.com, redcross.org"), "(site:harvard.edu OR site:redcross.org)");
});

test("applySiteRestrictionToQuery appends without dropping keywords", () => {
  assert.equal(
    applySiteRestrictionToQuery("technology committee", "site:harvard.edu OR site:mit.edu"),
    "(technology committee) site:harvard.edu OR site:mit.edu",
  );
});

test("site restriction isolates PDF-rare hosts like Reddit", () => {
  assert.equal(siteRestrictionTargetsOnlyPdfRareHosts(["reddit.com"]), true);
  assert.equal(siteRestrictionTargetsOnlyPdfRareHosts(["reddit.com", "acme.org"]), false);
  assert.equal(siteRestrictionTargetsOnlyPdfRareHosts([]), false);
});