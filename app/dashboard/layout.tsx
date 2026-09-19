import { redirect } from "next/navigation";

import { BuildTargetProvider } from "@/components/build-target-context";
import { LicenseGate } from "@/components/license-gate";
import { Shell } from "@/components/shell";
import { exeBuildTarget } from "@/lib/exe-build-target";
import { accountHref, isLocalExeRuntime } from "@/lib/exe-runtime";
import { getCurrentUser } from "@/lib/session-user";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const localExe = isLocalExeRuntime();

  // Desktop EXE runs fully offline — never touch the (remote) Postgres session read
  // here. The web host still does the authoritative DB gate below.
  const user = localExe ? null : await getCurrentUser();

  if (!localExe) {
    // Web hosting keeps the real gate: a DB read (authoritative), then email verify.
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