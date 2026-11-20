# TASK_176 — Nested launcher folder, ONE folder rename drives both levels (SCOPED 2026-10-06)

Owner: the launcher EXE currently sits in ONE renamed folder inside the
installer zip (`<inner>/Launcher.exe`). Owner wants it NESTED one level
deeper — the launcher lives in the INNER folder — and the public-link
mint UI must show only ONE folder rename: whatever the user types for
the folder applies to BOTH levels.

**Owner rule (binding, 2026-10-06): keep all three UI fields, no UI
changes — just use the same folder name for the nested folder as well.**

## 1. Target shape

Today (generator `launcher-build.ts:280-290`):

```
{ Update.lnk @ root,
  <inner>/Launcher.exe,
  <inner>/agent.bin,
  <inner>/<pdf> (when attached) }
```

Target:

```
{ Update.lnk @ root,
  <inner>/<inner>/Launcher.exe,
  <inner>/<inner>/agent.bin,
  <inner>/<inner>/<pdf> (when attached) }
```

- `<inner>` = the ONE user-typed folder name (`innerFolder`, bare-name
  `clean()`, default `launcher`). Both levels use the SAME string —
  e.g. folder rename `acme` → zip holds `acme/acme/Launcher.exe`.
- The PS-bridge `.lnk` targets `.\<inner>\<inner>\Launcher.exe` — pass
  the JOINED `inner\inner` relative path as the existing
  `-LauncherSubFolder` value (`launcher-build.ts:259-260`). No `.ps1`
  logic change, just a longer value.
- `launcher.c` payload needs NO change (sibling of exe, invariant kept);
  `open_pdf` parent-fallback already covers drift — PDF follows the exe
  so the sibling invariant holds.
- `Update.lnk` stays alone at the zip root. `zipName` / `updateLinkName`
  behaviour unchanged.

## 2. Files (three repos, additive-only, no migration)

1. **Generator** (`/Users/mikeolab/vantra-installer/generator/src/launcher-build.ts`):
   - `runLauncherBuild`: derive `nested = innerFolder + "/" + innerFolder`
     (after `clean()`); use `nested` for the three zip entries
     (`launcher-build.ts:282-289`), the `-LauncherSubFolder` arg
     (pass `innerFolder + "\\" + innerFolder`), and the `names:` object
     handed to `validateLauncherBuild`.
   - `launcher-validate.ts`: assert the doubled path (entries +
     bridge-args contain it).
2. **Vantra** (`/Users/mikeolab/vantra`): NO CHANGE NEEDED — the
   `installer` block (`zip-generator.ts`, `sw-installer-names.ts`,
   both routes) already forwards `innerFolder` opaquely; the doubling
   happens inside the generator. Only touch if a test pins the entry
   list (then update the expectation, not the plumbing).
3. **SpaceWorker** (`/Users/mikeolab/spaceworker`): NO UI CHANGE —
   `device-list.tsx` keeps all three rename fields exactly as today
   (`zipName`, `updateLinkName`/`linkName`, `innerFolder`/`folderName`);
   `lib/vantra-link.ts` + `install-link/route.ts` `parseNames` unchanged.
   The single `innerFolder` value flows through and the generator
   doubles it.

## 3. Verify

- Unit: mint with `innerFolder: "acme"` → assert zip entries are
  exactly `{ Update.lnk, acme/acme/Launcher.exe, acme/acme/agent.bin }`;
  assert bridge args contain `acme\acme\Launcher.exe`.
- Defaults: blank `innerFolder` → `launcher/launcher/Launcher.exe`
  (proves the doubling, not a passthrough bug).
- Bad name (`../evil`, 65 chars) → dropped per side → falls back to
  `launcher/launcher/` (same bare-name drop rule, never a 400).
- PDF: attached guide lands in the INNER folder next to the exe.
- Live: mint a real zip, open it, confirm the nested path in Explorer;
  VM install → checks in, no GUI dialog (P0 `--silent` still intact).
- Regressions: `test:vantra` (installer), hosting + wallet + support
  suites, `tsc --noEmit`, `CI=true npm run build`.

## 4. Explicitly out of scope

- No new rename field, no `nestedFolder` param, no UI redesign.
- No DB migration. No resolver/redirect change. No TASK_133.
- TASK_174 tier split stays parked until W6 lands (owner order).

Sized SMALL (was MEDIUM before the owner simplified it to same-name
doubling with zero UI work).
