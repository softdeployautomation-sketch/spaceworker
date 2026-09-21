import { redirect } from "next/navigation";

import { BuildTargetProvider } from "@/components/build-target-context";
import { LicenseGate } from "@/components/license-gate";
import { Shell } from "@/components/shell";
import { exeBuildTarget } from "@/lib/exe-build-target";
import { accountHref, isLocalExeRuntime } from "@/lib/exe-runtime";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const localExe = isLocalExeRuntime();

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
    return (
      // Publish the resolved build target to every client nav consumer (dock,
      // menu bar, the dashboard overview page's tiles, ...) via context — see
      // lib/exe-build-target.ts and components/build-target-context.tsx.
      <BuildTargetProvider value={build}>
        <LicenseGate build={build} buyHref={accountHref("/pricing")}>
          <Shell buildTarget={build}>{children}</Shell>
        </LicenseGate>
      </BuildTargetProvider>
    );
  }

  // Hosted web: explicitly provide no build target so consumers see the full nav.
  return (
    <BuildTargetProvider value={undefined}>
      <Shell>{children}</Shell>
    </BuildTargetProvider>
  );
}