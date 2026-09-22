import type { Metadata } from "next";
import { Badge, Card } from "@/components/ui";
import { PanicButton } from "@/components/panic-button";
import { VantraConnect } from "@/components/vantra-connect";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deviceStatus } from "@/lib/devices";

export const metadata: Metadata = { title: "Devices — SpaceWorker OS" };

// Task 92 — device surface placeholder. Read-only list + the panic switch +
// the latest digest. The full grid/detail/remote-tools (Vantra parity) ships
// with Task 95; every mutating action stays a gated proposal by design.

function statusTone(status: string): "success" | "danger" | "warning" | "neutral" {
  if (status === "online") return "success";
  if (status === "asleep") return "warning";
  if (status === "offline") return "danger";
  return "neutral";
}

export default async function DevicesPage() {
  const session = await getSession();
  if (!session) return null;
  const userId = session.sub;

  const [devices, latestDigest, digestEnabled, telemetryEnabled] = await Promise.all([
    prisma.device.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, deviceKind: true, status: true, lastSeenAt: true, osName: true, osVersion: true },
    }),
    prisma.activityRollup.findFirst({
      where: { userId },
      orderBy: { rollupDate: "desc" },
      select: { rollupDate: true, digestText: true },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { digestEnabled: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { deviceTelemetryEnabled: true } }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">Devices</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Your machines, their reachability, and the panic switch. Full remote
            control (gated proposals) arrives with the Vantra link.
          </p>
        </div>
        <PanicButton />
      </div>

      <VantraConnect />

      {devices.length === 0 ? (
        <Card className="p-8 text-center text-sm text-fg-muted">
          No devices linked yet. Install the Vantra agent via SpaceWorker to see
          your machines here — device provisioning ships with the next update.
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {devices.map((d) => (
            <Card key={d.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-fg">{d.name}</p>
                  <p className="text-xs text-fg-muted">
                    {d.osName ?? "Unknown OS"}
                    {d.osVersion ? ` ${d.osVersion}` : ""}
                    {d.deviceKind === "hosted" ? " · hosted" : ""}
                  </p>
                </div>
                <Badge tone={statusTone(deviceStatus(d))}>{deviceStatus(d)}</Badge>
              </div>
              <p className="mt-2 text-xs text-fg-muted">
                Last seen: {d.lastSeenAt ? d.lastSeenAt.toLocaleString() : "never"}
              </p>
            </Card>
          ))}
        </div>
      )}

      <Card className="p-6">
        <h2 className="text-lg font-semibold text-fg">Latest assistant digest</h2>
        {digestEnabled ? null : (
          <p className="mt-2 text-sm text-fg-muted">Daily digests are off in Settings.</p>
        )}
        {latestDigest ? (
          <div className="mt-3 rounded-lg border border-border bg-bg-elevated p-4 text-sm text-fg">
            <p className="text-xs text-fg-muted">
              {latestDigest.rollupDate.toISOString().slice(0, 10)}
            </p>
            <p className="mt-2 whitespace-pre-wrap">{latestDigest.digestText}</p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-fg-muted">
            No digest yet — your first one lands after a day of activity.
          </p>
        )}
      </Card>
    </div>
  );
}