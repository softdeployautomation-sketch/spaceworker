# TASK_160 — `zoneTokenError` / `workerTokenError` are never written, so a bad-scoped token can never go red

**Status: FIXED (2026-10-05), not deployed.** Zones half implemented and
tested; Workers half deliberately left unwritten — see §7.
Found 2026-10-05 while diagnosing the missing Cloudflare Zones tokens.
This is a **separate bug** from the Zones-token data gap and must not be conflated with it.

---

## 1. Context

Diagnosing why all three `HostingPlatformAccount` rows have a NULL
`zoneTokenCiphertext`. That diagnosis concluded the write path is correct and the
tokens were simply never saved (a data gap). While confirming the *read-back* and
*panel* contracts I went looking for the thing that would make a Zones token
**fail loudly**, and it does not exist.

## 2. The bug

Both per-capability error columns exist in the schema, are carried on the view,
are rendered as a red line by the panel, and are **written to exactly once — to
`null`**. Nothing in the codebase ever assigns a non-null reason to either.

Evidence (every write site in `lib/` + `app/`):

```
lib/hosting/platform-accounts.ts:108:    workerTokenError: row.workerTokenError ?? null,   # read
lib/hosting/platform-accounts.ts:111:    zoneTokenError: row.zoneTokenError ?? null,       # read
lib/hosting/credentials.ts:78:    workerTokenError: row.workerTokenError ?? null,         # read
lib/hosting/credentials.ts:202:  workerTokenError: null,   # the ONLY write — a clear
lib/hosting/credentials.ts:273:  zoneTokenError: null,     # the ONLY write — a clear
```

Columns confirmed present by migration:
- `prisma/migrations/20261101000000_task155_p6c_worker_token/migration.sql:24,31` — `ADD COLUMN "workerTokenError" TEXT;`
- `prisma/migrations/20261106000000_task158_zone_token/migration.sql:28` — `ADD COLUMN "zoneTokenError" TEXT;`

Rendered in the UI (both dead code as written):
- `components/admin/platform-accounts-panel.tsx:544` — `{a.workerTokenError && …}`
- `components/admin/platform-accounts-panel.tsx:561` — `{a.zoneTokenError && …}`
- `components/hosting-credentials-settings.tsx:222` — `{c.workerTokenError && …}`

## 3. Why it matters — the failure mode the Zones slot was built to prevent

`verifyPlatformAccount()` (`lib/hosting/platform-accounts.ts:597`) verifies **only
the Pages token**: it decrypts `tokenCiphertext` and calls `verifyCredential`.
It never reads `zoneTokenCiphertext` or `workerTokenCiphertext`, and
`markPlatformAccountVerified` (`lib/hosting/platform-accounts.ts:382`) writes
**only** `verifyError`.

So when the owner pastes a Zones token that is readable in the database but
**missing `com.cloudflare.api.account.zone.create`** — precisely the 403 that
blocks custom domains today — the row renders:

> Custom domains (zone create): token …abcd set

and stays **green forever**. `zoneTokenError` can never go red, so the panel never
warns. The failure only surfaces later, at provision time, as the
`zone-provision.ts:122` 403 string on an end-user's domain-add request — where the
operator is not looking.

This is the same class of bug as the one W2 just fixed: **a save whose only evidence
is the response body**. W2 made the *write* provable; this is the *capability* being
unprovable.

The Pages-token side IS genuinely covered, so this is a real asymmetry, not a
theoretical one: `verifyError` has a writer, the other two columns do not.

## 4. Scope of the fix — and a caveat I could not resolve

Verify each capability's token with **its own** credential and stamp its own error
column, mirroring the existing Pages handling. Roughly:

1. In `verifyPlatformAccount` (`lib/hosting/platform-accounts.ts:597`), after the
   Pages verdict, also `readZoneToken(row)` / `readWorkerToken(row)`; where a token
   exists, verify it and stamp the matching column via a new sibling of
   `markPlatformAccountVerified` (e.g. one taking `"zoneToken" | "workerToken"`).
2. `zoneTokenError` must stay NULL when there is **no** Zones token — the schema
   comment (`prisma/schema.prisma:1512-1514`) and the panel copy
   (`platform-accounts-panel.tsx:547-550`) both state absent is the normal,
   neutral state. A row without a Zones token must NOT be marked broken.
3. **The Workers token is the harder half and needs a decision first.** The Zones
   capability has an unambiguous cheap probe (`GET /zones?name=<apex>`, or a token
   self-check). There is no equally cheap, side-effect-free probe that proves a
   Workers token can both upload a script AND edit DNS. Options: verify Workers
   with a readability-only call and accept that it proves less than the label
   implies; or scope this task to the Zones token and leave `workerTokenError` dead
   with a comment saying why. **Recommend the latter** — fix what can be proven, and
   do not ship a green check that overstates what was verified.

## 5. Tests that should fail before and pass after

In `tests/hosting-platform-accounts.test.ts` (currently **325/325 pass**, verified
this session):

- **Fails before:** create an account with a `zoneToken`, stub `verifyCredential`
  to fail, call `verifyPlatformAccount(id)`, assert `view.zoneTokenError` is a
  non-empty string. Today it is `null`, so the test fails.
- **Passes after:** the same row with **no** `zoneToken` must still report
  `zoneTokenError === null` — the guard against "fixing" this by turning every
  unconfigured row red.
- **Never leaks:** assert the `zoneTokenError` string contains no part of the token
  and no ciphertext — the invariant the existing `no outcome path ever exposes a
  token` test (subtest 325) asserts elsewhere.

## 6. Live state confirmed this session (read-only)

All three rows: `zoneTokenCiphertext` / `zoneTokenIv` / `zoneTokenTag` **NULL**,
`zoneTokenHint` `""`, `zoneTokenError` NULL, `verifyError` NULL; Pages + Workers
hints present on 2 of 3. Consistent with the data-gap diagnosis.
**Production was not modified.**

---

## 7. What was built (2026-10-05)

`markPlatformCapabilityToken(id, "zoneToken" | "workerToken", error)` is the new
per-capability writer, a sibling of `markPlatformAccountVerified`.
`verifyPlatformAccount` now stamps the Zones verdict on **both** of its exit
paths — an unreadable Pages token must not hide an unreadable Zones token, since
they are independent credentials.

The probe is a read of a name that can never exist
(`spaceworker-zone-probe.invalid`, reserved by RFC 2606), via the existing
`getZoneByName()`. Side-effect free, costs nothing, and cannot be mistaken for a
zone the customer owns.

**Absent stays NULL**, decided from the ciphertext columns rather than from
`readZoneToken`'s return value: that helper swallows a decrypt failure and answers
null, indistinguishable from "never set". Asking it first would let an UNREADABLE
token skip the probe and render green — the original bug, reintroduced one level
down.

### The wording problem, which is the subtle part

`GET /zones` needs **Zone Read**, which is a *different grant* from **Zone
Create** — the permission custom domains actually need. A token scoped to Zone
Create alone 403s this probe while being perfectly able to add domains.

So the 403 message deliberately does **not** say the token is invalid. It says:
revoked, *or* missing Zone Read, and that Zone Create alone is enough to add
domains. Telling the owner their token is broken would send them to delete a
working token and replace it with one that 403s identically — a loop with no
exit. Cloudflare's own "Authentication error" is dropped rather than appended: it
is the one message in this path that actively misdirects.

A 5xx is reported as itself, and explicitly *not* as a verdict on the token.

### Still not proven

A token that reads zones but cannot create them still passes here and still 403s
at `zone-provision.ts:122`. Cloudflare grants no read endpoint behind
`zone.create`, so closing that gap would require attempting a real zone creation —
refused in a verification button. The panel says "reads zones on this account",
never "can create zones".

`workerTokenError` remains **deliberately unwritten**, with the reason recorded in
the code. There is no side-effect-free call that proves a Workers token can both
upload a script and edit DNS.

### Verification

334/334 hosting (was 325, +9 new), 30/30 support, 29/29 wallet, `tsc` clean,
eslint clean, `CI=true npm run build` exit 0. Saving a Zones token now re-verifies
immediately, so the column cannot be left empty-but-green by the save path.
