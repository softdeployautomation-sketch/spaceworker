import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPANSION_SUFFIXES,
  SUFFIX_PAIR_INDICES,
  roundQueries,
  biasQueryTowardPdfs,
} from "../src/query";

test("round 0 returns base terms unmodified", () => {
  assert.deepEqual(roundQueries(["roofing contractor"], 0), ["roofing contractor"]);
});

test("round N appends one expansion suffix", () => {
  const base = ["roofing contractor"];
  const out = roundQueries(base, 1);
  assert.deepEqual(out, [`roofing contractor${EXPANSION_SUFFIXES[0]}`]);
});

test("round N+1 appends a pair of suffixes", () => {
  const n = EXPANSION_SUFFIXES.length;
  const out = roundQueries(["term"], n + 1);
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith("term"));
  const [i, j] = SUFFIX_PAIR_INDICES[0];
  assert.equal(out[0], `term${EXPANSION_SUFFIXES[i]}${EXPANSION_SUFFIXES[j]}`);
});

test("a round past all pair combinations returns empty", () => {
  const n = EXPANSION_SUFFIXES.length;
  assert.deepEqual(roundQueries(["term"], n + 1 + SUFFIX_PAIR_INDICES.length), []);
});

test("suffix-pair count matches the real expansion list (29 → C(29,2)=406)", () => {
  const n = EXPANSION_SUFFIXES.length;
  assert.equal(SUFFIX_PAIR_INDICES.length, (n * (n - 1)) / 2, "pairs must equal C(n,2)");
  // The Python source's comment says "28 suffixes -> C(28,2)=378", but the actual
  // list in worker/automation.py holds 29 entries. We follow the REAL list here.
  assert.equal(n, 29);
  assert.equal(SUFFIX_PAIR_INDICES.length, 406);
});

test("biasQueryTowardPdfs appends filetype:pdf and intext:@ once", () => {
  assert.equal(biasQueryTowardPdfs("technology committee"), "technology committee filetype:pdf intext:@");
  assert.equal(
    biasQueryTowardPdfs("technology filetype:pdf intext:@"),
    "technology filetype:pdf intext:@",
  );
});