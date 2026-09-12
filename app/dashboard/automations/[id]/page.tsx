"use client";

// Task 27, Part B — run history / drill-down entry for one automation. Lists the
// automation's runs with their status and links through to each run's detail
// page (the Task 09 run-summary surface).

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Button, Card, Table, Td, Th } from "@/components/ui";
import { useParams } from "next/navigation";

interface Run {
  id: string;
  status: string;
  startedAt: string;
  extractionCompletedAt: string | null;
  completedAt: string | null;
  leadsExtracted: number | null;
  campaignId: string | null;
  errorMessage: string | null;
}

interface AutomationDetail {
  id: string;
  name: string;
  triggerMode: string;
  scheduleEnabled: boolean;
  runs?: Run[];
}

const STATUS_TONE: Record<string, "success" | "danger" | "warning" | "neutral"> = {
  running: "neutral",
  needs_confirmation: "warning",
  done: "success",
  failed: "danger",
  stopped: "neutral",
};

export default function AutomationHistoryPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [automation, setAutomation] = useState<AutomationDetail | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const res = await fetch(`/api/automations/${id}`);
    if (res.ok) setAutomation(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{automation?.name ?? "Automation"}</h1>
          <p className="mt-1 text-sm text-fg-muted">Run history for this automation.</p>
        </div>
        <Button variant="secondary" onClick={() => window.history.back()}>
          Back
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : !automation ? (
        <p className="text-sm text-fg-muted">Automation not found.</p>
      ) : (automation.runs?.length ?? 0) === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-fg-muted">No runs yet. Hit &quot;Run now&quot; from the Automations tab to start one.</p>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Started</Th>
                <Th>Status</Th>
                <Th>Leads</Th>
                <Th>Campaign</Th>
              </tr>
            </thead>
            <tbody>
              {automation.runs!.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <Td>{new Date(r.startedAt).toLocaleString()}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status.replace("_", " ")}</Badge>
                    {r.errorMessage && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{r.errorMessage}</p>}
                  </Td>
                  <Td>{r.leadsExtracted ?? "—"}</Td>
                  <Td>
                    {r.campaignId ? (
                      <Link href={`/dashboard/campaigns/${r.campaignId}`} className="text-brand-600 hover:underline dark:text-brand-300">
                        View campaign
                      </Link>
                    ) : (
                      <Link href={`/dashboard/automations/${id}/runs/${r.id}`} className="text-brand-600 hover:underline dark:text-brand-300">
                        Run detail ↗
                      </Link>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}