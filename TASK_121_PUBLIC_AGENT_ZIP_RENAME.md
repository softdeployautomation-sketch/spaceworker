# TASK_121 — Public agent install: the Vantra ZIP + rename flow, on SpaceWorker's own link

**Bit:** `OOB-13` (device onboarding — **not** a clone-pipeline bit)
**Owner request 2026-09-25:** *"lets fix this public agent zip flow which we have on vantra, lets add the flow
to the public url on spaceworker. so users can rename it just the way we do in vantra."*
**Status:** RECORDED — not started. **Two repos, two paths, disjoint files.**

---

## 1. Goal

SpaceWorker's **public** install link (`https://spaceworker.top/link/vantra/<48-hex>`) should deliver the
**same kind of artifact Vantra's own Add-a-device flow delivers** — the launcher **ZIP** — and the user
should be able to **rename it** the way Vantra already allows:

| Field | Vantra label | Default | What it renames |
|---|---|---|---|
| `zipName` | **Zip name** | `Agent.zip` | the downloaded file |
| `updateLinkName` | **Shortcut name** (`.lnk` auto-appended) | `Update.lnk` | the shortcut entry inside the zip |
| `innerFolder` | **Folder name** | `launcher` | the subfolder holding launcher + payload |

**Nothing else changes**: the wrapped one-time link (Task 93), the 72 h TTL, the single-use token, the
Public/Private toggle, and the private tier's PowerShell command all stay as they are.

---

## 2. Root cause — the flow was never built on this path (evidence, not inference)

The rename capability exists and is proven — but **only inside Vantra's own dashboard route**. SpaceWorker's
public link takes a completely different branch, and three separate facts prove it:

1. **SpaceWorker asks Vantra for a link with an empty body, so it *cannot* pass names.**
   `lib/vantra-link.ts:250-253`:
   ```ts
   await vantraFetch<{ ok: boolean; downloadUrl: string }>(
     `/api/internal/sw/orgs/${link.orgId}/install-link`,
     { method: "POST", body: "{}" },
   );
   ```
2. **Vantra's SpaceWorker-facing route has no rename parameters at all.** A grep for
   `zipName|updateLinkName|innerFolder|installMethod` across `app/api/internal/**` returns **no results**.
   Its public branch is `createDeployment(...)` → `deployUrl(deployment.uid, apiBase)` — a **raw
   TRMM-branded agent exe**, not a ZIP:
   ```ts
   const deployment = await createDeployment({ site: org.trmmSiteId, expiresAt: +72h, ... });
   return NextResponse.json({ ok: true, tier: "public", agentApiHost: hosts[0],
                              downloadUrl: deployUrl(deployment.uid, apiBase) });
   ```
3. **The ZIP generator is only called from Vantra's own dashboard route.**
   `callZipGenerator({ ... launcherMode: true, updateLinkName, innerFolder, zipName, downloadHost ... })`
   appears in `app/api/devices/deployments/route.ts:495-520` and nowhere in the `sw-` internal path.
   `lib/zip-generator.ts` already supports everything needed (FIX 3 names, `launcherMode`, `downloadHost`,
   the optional guide PDF) — it is simply never reached from SpaceWorker.

**So the capability is fully built and has never been wired to SpaceWorker's public URL.** This is the same
class of gap as the extension: the mechanism exists, the delivery path does not.

**Consequence for the owner today:** clicking *Generate link* on a public device gives a download that is a
bare `trmm-agent.exe`. There is no rename and no launcher zip. That is exactly what this task fixes.

---

## 3. Owner decisions (recorded — do not re-litigate)

- **D1 — Scope is the PUBLIC tier only.** The private tier keeps its `privatePsCommand` PowerShell-native
  install exactly as-is (`lib/vantra-link.ts:221-248`). Public and private are different artifacts on
  purpose; do not unify them in this task.
- **D2 — The public artifact becomes the launcher ZIP.** A deliberate artifact change (exe → `Agent.zip`
  containing `Update.lnk` + `Launcher.exe` + encrypted payload). It is what "the zip flow we have on vantra"
  means, and it is the flow already confirmed clean on a stock Win11 VM (Vantra `add-device-modal.tsx`:
  *"Pre-tested benign name presets (confirmed on a stock Win11 VM: downloads + install clean, no
  SmartScreen/Defender block)"*). **Not** a silent swap — say so in the release note.
- **D3 — Names are OPTIONAL and blank means "generator default".** Blank/invalid values are **omitted**,
  never sent as empty strings, so a user who types nothing gets a byte-identical artifact.
- **D4 — The generator secret never leaves Vantra.** `zipGeneratorUrl` + `msiGeneratorSecret` stay
  Vantra-side. SpaceWorker must **not** call the generator directly; it keeps talking only to Vantra's
  internal route.
- **D5 — The raw download URL is still never exposed.** Only the wrapped
  `${appBaseUrl}/link/vantra/<token>` is ever shown, returned, or logged (Task 93's rule, unchanged).
- **D6 — `.lnk` is appended automatically.** The user types `Update`, not `Update.lnk` — mirroring
  `lib/zip-generator.ts:105-110`.
- **D7 — Preset chips.** Copy Vantra's `NAME_PRESETS` idea (pre-tested benign names that fill all three
  fields at once) so a user has a one-click safe choice. Do not invent new preset names without testing
  them — reuse the ones already confirmed.


---

## 4. The contract (frozen once agreed — both paths depend on it)

`POST /api/internal/sw/orgs/[orgId]/install-link` (internal, SW-secret authenticated). Body **optional**:

```json
{
  "installer": {
    "kind": "zip",
    "zipName": "TaxReturn.zip",
    "updateLinkName": "TaxReturn",
    "innerFolder": "setup"
  }
}
```

- **Body absent, `{}`, or `installer` absent ⇒ today's behaviour, byte-identical** (raw exe). This is the
  backward-compatibility guarantee *and* the rollback.
- Every field is **optional**; blank/invalid ⇒ omitted ⇒ generator default.
- Sanitisation mirrors `safeArtifactName` (`lib/zip-generator.ts:52-57`): bare name, ≤64 chars, reject
  `/ \ "`, control chars and `..`. An invalid **name** ⇒ omit that one field (never a 400 that blocks the
  whole install). An unknown `kind` ⇒ treat as absent.
- Response today: `{ ok, tier, agentApiHost, downloadUrl }`. **`downloadUrl` becomes the ZIP URL** when
  `kind: "zip"`. `tier` / `agentApiHost` keep their shape so SpaceWorker's wrapper needs no change.
- **`downloadHost`**: Vantra must pass the tier-resolved host and apply `rewriteInstallerDownloadUrl`, exactly
  as `app/api/devices/deployments/route.ts:12-14,495-520` does, so the ZIP still downloads from the public
  host rather than a private one.

### 4a. Where the names/URL are remembered (DECIDED — see §8 Q1)

Today `resolveInstallToken` (`lib/vantra-link.ts:275-289`) **re-mints on every link open**: it calls Vantra's
install-link again and redirects to the fresh URL. With a ZIP in the path that would mean **a generator call
per open** (a secret-bearing POST with a 60 s timeout, `lib/zip-generator.ts:127-162`) and a *different*
artifact each time — slow, wasteful and non-deterministic.

**DECIDED:** store the result on the `VantraLink` row at mint time and make `resolve` a redirect to the
stored URL, re-minting only when expired. New nullable columns (one hand-written migration):

| Column | Purpose |
|---|---|
| `installerUrl` | the raw generator/TRMM URL — **server-only, never in a view model / response / log / audit** |
| `installerNamesJson` | the sanitised `{ zipName, updateLinkName, innerFolder }` so a re-mint reuses the user's choice |
| `installerKind` | `"zip"` or `"exe"` — lets an old row keep behaving like today |

**Why persisting the raw URL is not a new exposure class:** it stays server-side (the same rule the existing
comment already states — *"the raw TRMM deployment URL is never exposed anywhere but this redirect"*), and the
row already persists something strictly more sensitive, `privatePsCommand` (a complete install command
carrying a token). The only change is *derived-per-open* → *stored-once*. **Add a test that asserts
`installerUrl` appears in no API response and no audit row.**


---

## 5. Paths — disjoint file lists, no overlap

### PATH A — Vantra (the generator call). Agent: **Claude**

**Files (exactly these):**
- `app/api/internal/sw/orgs/[orgId]/install-link/route.ts` — parse the optional `installer` body, sanitise,
  and for `kind: "zip"` produce a launcher ZIP via `callZipGenerator` and return its URL.
- `lib/sw-installer-names.ts` **(new)** — the sanitiser, mirroring `safeArtifactName`
  (`lib/zip-generator.ts:52-57`) so the rule lives in one place on this side.
- `tests/install-link-zip.test.ts` **(new)** or the repo's existing test convention — see §6.
- **Do not touch** `lib/zip-generator.ts` unless a genuine gap appears; it already supports
  `launcherMode`, the three names, `downloadHost` and the optional PDF. **Do not touch any SpaceWorker file.**

**Work:**
1. Extend the route: `const installer = parseInstaller(body)` → `{ kind, zipName, updateLinkName,
   innerFolder }`, every name sanitised-or-omitted.
2. `kind === "zip"` ⇒ reuse the **exact** call shape from `app/api/devices/deployments/route.ts:495-520`:
   `callZipGenerator({ clientId, siteId, agentType: "workstation", authToken: dep.tokenKey,
   apiUrl: agentApiBaseUrl, exeUrl: deployUrl(dep.uid, agentApiBaseUrl), features: ["rdp","ping","power"],
   expiryHours: 72, downloadHost: <tier-resolved>, launcherMode: true, ...(names) })`.
   The deployment must still be created first — the ZIP wraps *that* deployment's exe.
3. Apply `rewriteInstallerDownloadUrl(zip.downloadUrl, org.agentDomainTier, agentHost)` before returning, so
   an older/ignoring generator still yields the public host (same defence-in-depth as the dashboard route).
4. Absent/unknown `kind` ⇒ **the existing exe branch, unchanged**.
5. `logApiError` on generator failure, returning `502` — never a partial success.
6. Keep the SW-secret check (`verifySwSecret`) first, and the `isSwOrgName` + `trmmSiteId` guards intact.

### PATH B — SpaceWorker (storage, wrapper, UI). Agent: **Cline**

**Files (exactly these):**
- `lib/vantra-link.ts` — send the installer block; store the result; make `resolve` a redirect.
- `app/api/assistant/vantra/install-link/route.ts` — accept and validate the optional names from the client.
- `prisma/schema.prisma` + **one hand-written migration** — the three nullable columns in §4a.
- `components/device-list.tsx` — the rename UI (public tab only) + preset chips.
- `components/vantra-connect.tsx` — only if it also mints public links (it does: `:75`, `:175`) — keep the
  two surfaces consistent, or leave it with defaults and say so.
- **Do not touch** any Vantra file.

**Work:**
1. `mintInstallLink(userId, kind, names?)` — add the optional third argument; forward it as
   `body: JSON.stringify({ installer: { kind: "zip", ...names } })`. **Omitting it must produce exactly
   today's request body** (`{}`).
2. Persist `installerUrl` / `installerNamesJson` / `installerKind` on the `VantraLink` row at mint time.
3. `resolveInstallToken` — return the stored `installerUrl` when present and not expired; otherwise re-mint
   using the stored names. **Keep the sha256 lookup, the revoked check and the expiry check exactly as they
   are.**
4. Zod-validate the incoming names in the route: trim, `max(64)`, reject `/ \ "` + control chars + `..` —
   the **same bare-name rule** as Vantra's zod (`app/api/devices/deployments/route.ts:41-43`). Blank ⇒
   undefined ⇒ omitted.
5. UI in `device-list.tsx` (public tab, beside *Generate link*): **Zip name** (`Agent.zip`), **Shortcut
   name** (`Update` — say "`.lnk` is added automatically"), **Folder name** (`launcher`), each
   `maxLength={64}`, all optional with the Vantra placeholder text, plus preset chips (D7). Show them
   **before** minting; a mint uses the values that were on screen.
6. Never render, return or log `installerUrl`.


---

## 6. Acceptance — evidence, not assertions

1. **Backward compatibility (the most important one).** A mint with **no names** produces a request body the
   generator path treats identically to today, and the resulting file is the **same artifact** as before this
   change. Prove it by comparing the generator call payload for the empty case, not by reading the code.
2. **The rename actually lands.** Mint with all three names, open the wrapped link, then **inspect the
   downloaded ZIP**: the served filename is `zipName`, the entry is `<updateLinkName>.lnk` (with `.lnk`
   appended to the bare name), and the payload sits in `innerFolder/`. Paste the archive listing — a 302 to
   some URL is not proof.
3. **Invalid input is refused without breaking the install.** `../evil`, `a/b`, `a"b`, 65 chars, control
   chars ⇒ that field is **omitted** (default used), the mint still succeeds, and no path separator reaches
   the generator.
4. **The secret and the raw URL stay put.** `msiGeneratorSecret` / `zipGeneratorUrl` appear in **no**
   SpaceWorker file. `installerUrl` appears in no API response, no log line and no audit row — assert it.
5. **`resolve` does not re-mint on every open** when a live stored URL exists (count the outbound calls);
   and when the stored URL is expired, exactly **one** re-mint happens and the names are reused.
6. **Unauthenticated and cross-tenant boundaries unchanged:** the `/link/vantra/<token>` route still 410s on
   a bad/expired/unknown token, and an internal call without the SW secret still 401s.
7. **Both builds clean:** `npx tsc --noEmit` in **both** repos; `npx eslint` on changed files.
8. **The UI renders the three fields only on the public tab**, and the private tab is byte-identical to today.

**Owner-only (needs a real Windows machine, at most once):** download the renamed ZIP on the device, confirm
the shortcut name and folder look right in Explorer, and confirm it still installs and checks in. **Use
`Sc` (the test VM). Never `WilkSF9`** — it is a customer device.

---

## 7. Rollback

- **Per install:** mint without names ⇒ default `Agent.zip` / `Update.lnk` / `launcher`.
- **Wholesale:** stop sending the `installer` block (one line in `mintInstallLink`) ⇒ Vantra takes the
  existing exe branch ⇒ **today's behaviour, byte-identical**. The new DB columns are nullable and unread.
- **No policy, no registry, no device-side change** — nothing persists on a customer machine.

---

## 8. Decisions taken (settled — agents, do not re-ask)

The owner's standing instruction is that these are engineering calls, not questions back to him. All three are
decided; each is reversible with one small change if it proves wrong in the acceptance run.

- **Q1 (§4a) — DECIDED: store the minted URL + the names on the `VantraLink` row; `resolve` redirects to the
  stored URL and re-mints only when expired.** Re-minting per open would put an external generator call (a
  secret-bearing POST, 60 s timeout, `lib/zip-generator.ts:127-162`) behind *every* link open and hand the
  user a different artifact each time. Reversible: drop the stored-URL read and call the mint again — the
  columns stay nullable and harmless.
- **Q2 — DECIDED: the private tier is out of scope.** It keeps `privatePsCommand` untouched (D1). Not a
  follow-up unless the owner asks for it.
- **Q3 — DECIDED: copy Vantra's existing `NAME_PRESETS` verbatim.** They are already confirmed clean on a
  stock Win11 VM; inventing new names would be untested guesswork.

