import { redirect } from "next/navigation";

import { BuildTargetProvider } from "@/components/build-target-context";
import { LicenseGate } from "@/components/license-gate";
import { Shell } from "@/components/shell";
import { WrapperModeProvider } from "@/components/wrapper-mode-context";
import { exeBuildTarget } from "@/lib/exe-build-target";
import { accountHref, isLocalExeRuntime } from "@/lib/exe-runtime";
import { resolveWrapperMode } from "@/lib/wrapper-mode";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const localExe = isLocalExeRuntime();
  // TASK_181 D2 — resolved ONCE here (server-only env read) and injected for
  // nav/copy consumers. null on every hosted-web request: flag absent ⇒ the
  // provider below receives null ⇒ every consumer behaves exactly as today.
  // TASK_183 — now env OR the `sw_wrapper` cookie: the hosted wrapper window
  // (the EXE no longer runs a local runtime) carries its scope via the cookie
  // set by GET /wrapper/devices; env stays authoritative for dev/tests.
  const wrapper = await resolveWrapperMode();

  if (!localExe) {
    // Web hosting keeps the real gate: a DB read (authoritative), then email verify.
    //
    // Dynamic import, deliberately — this is the ONE place the EXE's request path
    // used to statically pull in lib/session-user.ts -> lib/db.ts / lib/premium.ts
    // -> @prisma/client. A static top-level `import { getCurrentUser } from
    // "@/lib/session-user"` gets its ENTIRE transitive module graph bundled and
    // evaluated at load time regardless of which branch below actually runs — the
    // old `const user = localExe ? null : await getCurrentUser()` guarded the
    // CALL, not the IMPORT, so the EXE (which ships with no DATABASE_URL by
    // design) crashed on module load before this function body ever ran. A
    // dynamic import here only loads — and only bundles into a separate chunk —
    // when this branch actually executes, which never happens for the EXE.
    const { getCurrentUser } = await import("@/lib/session-user");
    const user = await getCurrentUser();
    if (!user) redirect("/login");
    if (!user.emailVerified) redirect(`/verify?email=${encodeURIComponent(user.email)}`);
  }

  // Desktop EXE (local runtime, no web login): wrap the whole dashboard in the
  // shared <LicenseGate> (Task 27 Part A §"Licensing gate UI") — silent 24h trial
  // on first launch, activation gate once it expires, same component compiled into
  // every EXE build. Only the dashboard behind it differs per build target. The
  // gate runs fully offline (local /api/exe-license/* routes, embedded secret).
  if (localExe) {
    const build = exeBuildTarget();
    // TASK_183 — the devices wrapper NEVER sees a license gate (owner: "each
    // trim gets its own licensing route" — the wrapper has none; it connects to
    // the hosted app where access = session + server-side entitlements). The
    // 24h extractor trial belongs to the standalone extractor EXE only. In
    // practice the shipped wrapper no longer runs this local runtime at all
    // (window → hosted), but dev via run-exe-dev.sh still hits this branch, so
    // the skip must live here too. Structure note: the gate wrapped Shell for
    // every local EXE before — wrapper drops ONLY the gate; providers stay.
    return (
      // Publish the resolved build target to every client nav consumer (dock,
      // menu bar, the dashboard overview page's tiles, ...) via context — see
      // lib/exe-build-target.ts and components/build-target-context.tsx.
      <BuildTargetProvider value={build}>
        <WrapperModeProvider value={wrapper}>
          {wrapper ? (
            <Shell buildTarget={undefined}>{children}</Shell>
          ) : (
            <LicenseGate build={build} buyHref={accountHref("/pricing")}>
              {/* TASK_181 — a wrapper build takes the server-bound shell: NO
                  buildTarget on <Shell>, so the wallet chip, Sign out, support
                  and agent all stay (owner: top bar "as-is"). buildTarget on
                  Shell is what hides them (components/shell.tsx:52,56,77), and
                  the wrapper is explicitly NOT the local-runtime-without-DB
                  path (D2). Nav narrows via WrapperModeProvider, not via
                  BUILD_ALLOWED_HREFS. */}
              <Shell buildTarget={build}>{children}</Shell>
            </LicenseGate>
          )}
        </WrapperModeProvider>
      </BuildTargetProvider>
    );
  }

  // Hosted web: explicitly provide no build target so consumers see the full nav.
  return (
    <BuildTargetProvider value={undefined}>
      <WrapperModeProvider value={wrapper}>
        <Shell>{children}</Shell>
      </WrapperModeProvider>
    </BuildTargetProvider>
  );
}