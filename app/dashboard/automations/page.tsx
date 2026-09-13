"use client";

// Task 27, Part B — the manual CampaignAutomation builder (replaces the Task 26
// Piece 6 placeholder). Lists saved automations with their latest run, and
// provides a multi-step create form (lead source -> campaign template ->
// mailboxes -> trigger), plus run-now / pause / resume / delete and a link to
// each run's detail page.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Input, Label, Select, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-provider";

type RunStatus = "running" | "needs_confirmation" | "done" | "failed" | "stopped";

interface LatestRun {
  id: string;
  status: RunStatus;
  startedAt: string;
}

interface Automation {
  id: string;
  name: string;
  leadSource: string;
  findTerms: string[];
  locationTerms: string[];
  campaignTemplateId: string;
  mailboxIds: string[];
  personalListIds?: string[];
  triggerMode: string;
  scheduleHour: number | null;
  scheduleEnabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  runCount: number;
  runs?: LatestRun[];
  _count?: { runs: number };
}

interface CampaignOption {
  id: string;
  name: string;
  variants: { id: string }[];
}

interface MailboxOption {
  id: string;
  label: string;
  username: string;
}

interface UploadJobOption {
  id: string;
  query: string;
  _count?: { leads: number };
}

// --- Task 31, item 3 — "Ask the agent" chat panel types ---------------------
interface AgentMessage {
  id: string;
  role: string;
  content: string;
  toolCall: unknown;
  createdAt: string;
}

interface AgentPendingAction {
  id: string;
  kind: "job" | "campaign";
  payload: Record<string, unknown>;
  proposal: string | null;
  expiresAt: string;
}

interface AgentJobOutcome {
  status: string;
  ledCount: number;
  validCount: number;
  invalidCount: number;
  uncheckedCount: number;
}

interface AgentOutcome {
  kind: "job" | "campaign";
  status: string;
  executedJobId: string | null;
  executedCampaignId: string | null;
  job?: AgentJobOutcome;
  campaign?: { id: string };
}

interface AgentOutcomeView {
  phase: "pending" | "rejected" | "executed" | "error";
  outcome?: AgentOutcome;
  requestedLeads?: number;
}

const TRIGGER_LABEL: Record<string, string> = {
  manual: "Manual",
  daily: "Daily",
};

const RUN_STATUS_TONE: Record<RunStatus, "success" | "danger" | "warning" | "neutral"> = {
  running: "neutral",
  needs_confirmation: "warning",
  done: "success",
  failed: "danger",
  stopped: "neutral",
};

function summarizeTerms(findTerms: string[], locationTerms: string[], leadSource: string): string {
  if (leadSource === "personal_list") return "Personal list";
  const f = findTerms.length === 1 ? findTerms[0] : `${findTerms[0]} +${findTerms.length - 1}`;
  if (locationTerms.length === 0) return f;
  return `${f} in ${locationTerms.length === 1 ? locationTerms[0] : `${locationTerms.length} locations`}`;
}

// --- Task 31, item 3 — agent payload readers ---------------------------------
function payloadArr(payload: Record<string, unknown>, key: string): string[] {
  const v = payload[key];
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "").trim()).filter((x) => x.length > 0);
}

function payloadNum(payload: Record<string, unknown>, key: string): number | undefined {
  const n = Number(payload[key]);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function payloadStr(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === "string" ? (payload[key] as string) : "";
}

// SearchJob statuses: "queued" | "running" | "done" | "failed" | "paused" | "stopped".
function jobStillWorking(status: string | undefined): boolean {
  return status === "queued" || status === "running";
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export default function AutomationsPage() {
  const { push } = useToast();
  const confirm = useConfirm();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  // Task 28, item 5 — system-owned "ready-made" campaign templates, listed as a
  // second group in the template picker (empty when the feature isn't configured).
  const [templates, setTemplates] = useState<CampaignOption[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
  const [uploadJobs, setUploadJobs] = useState<UploadJobOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // Create / edit form state (multi-step).
  const [editTarget, setEditTarget] = useState<Automation | null>(null);
  const [step, setStep] = useState(0);
  const [formName, setFormName] = useState("");
  const [leadSource, setLeadSource] = useState<"extract" | "personal_list">("extract");
  const [findInput, setFindInput] = useState("");
  const [findTerms, setFindTerms] = useState<string[]>([]);
  const [locInput, setLocInput] = useState("");
  const [locations, setLocations] = useState<string[]>([]);
  const [campaignTemplateId, setCampaignTemplateId] = useState("");
  const [mailboxSelections, setMailboxSelections] = useState<Set<string>>(new Set());
  // Task 29, item 2 — personal_list source is a MULTI-select of uploaded lists
  // (was a single personalListId), and uploadJobs is refreshed each time the
  // create/edit modal opens so a list uploaded on the Extract page shows up
  // without a full page reload (the reported "doesn't load the list" bug).
  const [personalListSelections, setPersonalListSelections] = useState<Set<string>>(new Set());
  const [triggerMode, setTriggerMode] = useState<"manual" | "daily">("manual");
  const [scheduleHour, setScheduleHour] = useState(9);
  const [formError, setFormError] = useState("");

  // Task 31, item 3 — "Ask the agent" chat panel state.
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [agentPending, setAgentPending] = useState<AgentPendingAction[]>([]);
  const [agentInput, setAgentInput] = useState("");
  const [agentSending, setAgentSending] = useState(false);
  const [agentBusyId, setAgentBusyId] = useState<string | null>(null);
  const [agentOutcomes, setAgentOutcomes] = useState<Record<string, AgentOutcomeView>>({});
  const [mailboxCount, setMailboxCount] = useState(0);
  const agentInputRef = useRef<HTMLDivElement>(null);

  async function loadAll() {
    try {
      setLoading(true);
      const [autoRes, campRes, templRes, mbRes, jobsRes] = await Promise.all([
        fetch("/api/automations"),
        fetch("/api/campaigns"),
        fetch("/api/automations/templates"),
        fetch("/api/mailboxes"),
        fetch("/api/jobs"),
      ]);
      if (autoRes.ok) setAutomations(await autoRes.json());
      if (campRes.ok) setCampaigns(await campRes.json());
      if (templRes.ok) setTemplates(await templRes.json());
      if (mbRes.ok) setMailboxes(await mbRes.json());
      if (jobsRes.ok) {
        const jobs = (await jobsRes.json()) as (UploadJobOption & { template: string })[];
        setUploadJobs(jobs.filter((j) => j.template === "upload"));
      }
    } catch {
      push("Failed to load automations", "error");
    } finally {
      setLoading(false);
    }
  }

  async function loadAgent() {
    try {
      const [master, mb] = await Promise.all([fetch("/api/agent"), fetch("/api/mailboxes")]);
      if (mb.ok) {
        const arr = (await mb.json()) as unknown[];
        setMailboxCount(Array.isArray(arr) ? arr.length : 0);
      }
      if (master.ok) {
        const data = (await master.json()) as {
          messages?: AgentMessage[];
          pending?: AgentPendingAction[];
        };
        setAgentMessages(data.messages ?? []);
        setAgentPending(data.pending ?? []);
      }
    } catch {
      push("Failed to load the agent chat", "error");
    }
  }

  useEffect(() => {
    void loadAll();
    // Task 31, item 3 — load the agent chat + mailbox count once on mount too,
    // reusing this single mount effect so we don't add a second setState-in-effect.
    void loadAgent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Task 29, item 2 — refresh just the uploaded-list dropdown whenever the
  // create/edit modal opens, so a list just uploaded on the Extract page is
  // visible immediately without a full page reload (the reported bug).
  async function refreshUploadJobs() {
    try {
      const res = await fetch("/api/jobs");
      if (!res.ok) return;
      const jobs = (await res.json()) as (UploadJobOption & { template: string })[];
      setUploadJobs(jobs.filter((j) => j.template === "upload"));
    } catch {
      // Best-effort — the modal still works with the cached list.
    }
  }

  function openCreate() {
    setEditTarget(null);
    setStep(0);
    setFormName("");
    setLeadSource("extract");
    setFindInput("");
    setFindTerms([]);
    setLocInput("");
    setLocations([]);
    setCampaignTemplateId("");
    setMailboxSelections(new Set());
    setPersonalListSelections(new Set());
    setTriggerMode("manual");
    setScheduleHour(9);
    setFormError("");
    setCreateOpen(true);
    void refreshUploadJobs();
  }

  function openEdit(a: Automation) {
    setEditTarget(a);
    setStep(0);
    setFormName(a.name);
    setLeadSource(a.leadSource === "personal_list" ? "personal_list" : "extract");
    setFindTerms(a.findTerms ?? []);
    setLocations(a.locationTerms ?? []);
    setCampaignTemplateId(a.campaignTemplateId);
    setMailboxSelections(new Set(a.mailboxIds));
    setPersonalListSelections(
      new Set(a.leadSource === "personal_list" ? (a.personalListIds ?? []) : [])
    );
    setTriggerMode(a.triggerMode === "daily" ? "daily" : "manual");
    setScheduleHour(a.scheduleHour ?? 9);
    setFormError("");
    setCreateOpen(true);
    void refreshUploadJobs();
  }

  function addChip(value: string, list: string[], set: (v: string[]) => void) {
    const v = value.trim();
    if (v && !list.includes(v)) set([...list, v]);
  }

  function toggleMailbox(id: string) {
    setMailboxSelections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePersonalList(id: string) {
    setPersonalListSelections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submitForm() {
    setFormError("");
    if (!formName.trim()) return setFormError("Name is required");
    if (leadSource === "extract" && findTerms.length === 0) return setFormError("Add at least one Find term");
    if (leadSource === "personal_list" && personalListSelections.size === 0) return setFormError("Select at least one uploaded lead list");
    if (!campaignTemplateId) return setFormError("Select a campaign template");
    if (mailboxSelections.size === 0) return setFormError("Select at least one sending mailbox");
    if (triggerMode === "daily" && (scheduleHour < 0 || scheduleHour > 23)) return setFormError("Pick an hour 0-23 UTC");

    const body = {
      name: formName.trim(),
      leadSource,
      findTerms,
      locationTerms: locations,
      params: { engine: "duckduckgo", resultMode: "namesEmails" },
      personalListIds: leadSource === "personal_list" ? [...personalListSelections] : [],
      campaignTemplateId,
      mailboxIds: [...mailboxSelections],
      triggerMode,
      scheduleHour,
    };

    setCreating(true);
    try {
      const url = editTarget ? `/api/automations/${editTarget.id}` : "/api/automations";
      const res = await fetch(url, {
        method: editTarget ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to save automation");
      push(editTarget ? "Automation updated" : "Automation created", "success");
      setCreateOpen(false);
      setEditTarget(null);
      await loadAll();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to save automation");
    } finally {
      setCreating(false);
    }
  }

  async function runNow(automation: Automation) {
    try {
      const res = await fetch(`/api/automations/${automation.id}/run`, { method: "POST" });
      const d = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !d.runId) throw new Error(d.error ?? "Failed to start run");
      push("Run started", "success");
      await loadAll();
      return d.runId;
    } catch (e) {
      push(e instanceof Error ? e.message : "Failed to start run", "error");
    }
  }

  async function toggleSchedule(automation: Automation) {
    const action = automation.scheduleEnabled ? "pause" : "resume";
    await fetch(`/api/automations/${automation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    push(action === "pause" ? "Automation paused" : "Automation resumed", "success");
    await loadAll();
  }

  async function removeAutomation(automation: Automation) {
    if (!(await confirm({
      title: `Delete "${automation.name}"?`,
      description: "This deletes the automation and all its run history. This can't be undone.",
      confirmLabel: "Delete",
    }))) return;
    await fetch(`/api/automations/${automation.id}`, { method: "DELETE" });
    push("Automation deleted", "success");
    await loadAll();
  }

  // --- Task 31, item 3 — "Ask the agent" chat panel handlers ----------------
  async function sendAgentMessage(text?: string) {
    const msg = (text ?? agentInput).trim();
    if (!msg || agentSending) return;
    setAgentSending(true);
    setAgentInput("");
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        push(err.error || "Agent request failed", "error");
        return;
      }
      const data = (await res.json()) as {
        reply?: string;
        pendingAction?: AgentPendingAction;
        messages?: AgentMessage[];
      };
      if (data.messages) setAgentMessages(data.messages);
      if (data.pendingAction) {
        setAgentPending((prev) => [data.pendingAction!, ...prev]);
      }
    } catch {
      push("Agent request failed", "error");
    } finally {
      setAgentSending(false);
    }
  }

  async function approveAction(action: AgentPendingAction) {
    setAgentBusyId(action.id);
    try {
      const res = await fetch(`/api/agent/actions/${action.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        push(err.error || "Approval failed", "error");
        return;
      }
      const data = (await res.json()) as { ok?: boolean; kind?: string };
      setAgentPending((prev) => prev.filter((a) => a.id !== action.id));
      const requestedLeads = action.kind === "job" ? payloadNum(action.payload, "min_results") : undefined;
      setAgentOutcomes((prev) => ({
        ...prev,
        [action.id]: { phase: "pending", requestedLeads },
      }));
      push(data.kind === "campaign" ? "Campaign created" : "Job started", "success");
      void pollAgentOutcome(action.id, requestedLeads, 0);
    } catch {
      push("Approval request failed", "error");
    } finally {
      setAgentBusyId(null);
    }
  }

  async function rejectAction(action: AgentPendingAction) {
    setAgentBusyId(action.id);
    try {
      const res = await fetch(`/api/agent/actions/${action.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "reject" }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        push(err.error || "Reject failed", "error");
        return;
      }
      setAgentPending((prev) => prev.filter((a) => a.id !== action.id));
      setAgentOutcomes((prev) => ({ ...prev, [action.id]: { phase: "rejected" } }));
      push("Proposal rejected", "info");
    } catch {
      push("Reject request failed", "error");
    } finally {
      setAgentBusyId(null);
    }
  }

  async function pollAgentOutcome(actionId: string, requestedLeads?: number, attempt = 0) {
    try {
      const res = await fetch(`/api/agent/actions/${actionId}`);
      if (res.status === 404) {
        setAgentOutcomes((prev) => ({ ...prev, [actionId]: { phase: "error" } }));
        return;
      }
      if (!res.ok) return;
      const outcome = (await res.json()) as AgentOutcome | { error?: string };
      if (outcome && typeof outcome === "object" && "kind" in outcome) {
        const o = outcome as AgentOutcome;
        setAgentOutcomes((prev) => ({
          ...prev,
          [actionId]: {
            phase: "executed",
            outcome: o,
            requestedLeads: prev[actionId]?.requestedLeads ?? requestedLeads,
          },
        }));
        if (o.kind === "job" && jobStillWorking(o.job?.status) && attempt < 20) {
          window.setTimeout(() => void pollAgentOutcome(actionId, requestedLeads, attempt + 1), 5000);
        }
      }
    } catch {
      // Stop polling on network failure; the panel still shows the last snapshot.
    }
  }

  async function planCampaignFollowUp(jobId: string) {
    await sendAgentMessage(
      `The extraction job ${jobId} has finished. Please propose an email campaign to follow up with these leads.`
    );
  }

  function focusAgentInput() {
    agentInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    agentInputRef.current?.querySelector("input")?.focus();
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Automations</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Save a re-runnable extract + send config. Trigger it manually or let it run daily.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={focusAgentInput}>
            Ask the agent
          </Button>
          <Button onClick={openCreate}>{createOpen ? "Cancel" : "New automation"}</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-6">
      {loading ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : automations.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-fg-muted">
            No automations yet. Create one to save an outreach config you can run on demand or daily.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {automations.map((a) => {
            const latest = a.runs?.[0];
            const isDaily = a.triggerMode === "daily";
            return (
              <Card key={a.id} className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{a.name}</p>
                    <p className="truncate text-sm text-fg-muted">
                      {summarizeTerms(a.findTerms, a.locationTerms, a.leadSource)} ·{" "}
                      {a.mailboxIds.length} mailbox{a.mailboxIds.length === 1 ? "" : "es"}
                    </p>
                  </div>
                  <Badge tone={isDaily ? "warning" : "neutral"}>
                    {isDaily ? `${TRIGGER_LABEL.daily} at ${String(a.scheduleHour ?? 0).padStart(2, "0")}:00 UTC${a.scheduleEnabled ? "" : " (paused)"}` : TRIGGER_LABEL.manual}
                  </Badge>
                  {latest && <Badge tone={RUN_STATUS_TONE[latest.status] ?? "neutral"}>{latest.status.replace("_", " ")}</Badge>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => {
                      void runNow(a).then((runId) => {
                        if (runId) window.location.href = `/dashboard/automations/${a.id}/runs/${runId}`;
                      });
                    }}
                  >
                    Run now
                  </Button>
                  <Button variant="secondary" onClick={() => openEdit(a)}>
                    Edit
                  </Button>
                  {isDaily && (
                    <Button variant="secondary" onClick={() => void toggleSchedule(a)}>
                      {a.scheduleEnabled ? "Pause" : "Resume"}
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => void removeAutomation(a)}>
                    Delete
                  </Button>
                  <Link
                    href={`/dashboard/automations/${a.id}`}
                    className="ml-auto text-sm font-medium text-brand-600 hover:underline dark:text-brand-300"
                  >
                    Runs & history →
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {createOpen && (
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{editTarget ? "Edit automation" : "New automation"}</h2>
            <div className="flex items-center gap-1 text-xs text-fg-muted">
              {["Details", "Lead source", "Template", "Mailboxes", "Trigger"].map((label, i) => (
                <span key={label} className={i === step ? "font-semibold text-brand-600 dark:text-brand-300" : ""}>
                  {i + 1}. {label}
                  {i < 4 && <span className="mx-1 text-fg-muted/50">→</span>}
                </span>
              ))}
            </div>
          </div>

          {step === 0 && (
            <div className="flex flex-col gap-4">
              <div>
                <Label>Name</Label>
                <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. AI apps outreach" />
              </div>
              <div>
                <Label>Lead source</Label>
                <div className="flex gap-2">
                  {(["extract", "personal_list"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setLeadSource(s)}
                      className={`rounded-lg border px-3 py-2 text-sm ${leadSource === s ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300" : "border-border"}`}
                    >
                      {s === "extract" ? "Fresh extraction" : "Personal list"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 1 && leadSource === "extract" && (
            <div className="flex flex-col gap-4">
              <div>
                <Label>Find</Label>
                <div className="flex gap-2">
                  <Input value={findInput} onChange={(e) => setFindInput(e.target.value)} placeholder="e.g. plumbers" />
                  <Button type="button" variant="secondary" onClick={() => addChip(findInput, findTerms, setFindTerms)}>
                    Add
                  </Button>
                </div>
                {findTerms.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {findTerms.map((t) => (
                      <Badge key={t} onClick={() => setFindTerms(findTerms.filter((x) => x !== t))}>
                        {t} ✕
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <Label>Location (optional)</Label>
                <div className="flex gap-2">
                  <Input value={locInput} onChange={(e) => setLocInput(e.target.value)} placeholder="e.g. Texas" />
                  <Button type="button" variant="secondary" onClick={() => addChip(locInput, locations, setLocations)}>
                    Add
                  </Button>
                </div>
                {locations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {locations.map((t) => (
                      <Badge key={t} onClick={() => setLocations(locations.filter((x) => x !== t))}>
                        {t} ✕
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 1 && leadSource === "personal_list" && (
            <div>
              <Label>Choose uploaded lead lists ({personalListSelections.size} selected)</Label>
              <div className="mt-1 flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border">
                {uploadJobs.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-fg-muted">No uploaded lists yet — upload one from the Extract page, then reopen this panel.</p>
                ) : (
                  uploadJobs.map((j) => (
                    <label key={j.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={personalListSelections.has(j.id)}
                        onChange={() => togglePersonalList(j.id)}
                        className="h-4 w-4 accent-brand-500"
                      />
                      <span className="font-medium">{j.query}</span>
                      <span className="text-xs text-fg-muted">({j._count?.leads ?? 0} leads)</span>
                    </label>
                  ))
                )}
              </div>
              <p className="mt-2 text-xs text-fg-muted">
                Runs merge validated leads from every selected list, deduped by email. Lists upload on the Extract page appear here the moment you open this panel.
              </p>
            </div>
          )}

          {step === 2 && (
            <div>
              <Label>Campaign template</Label>
              <Select value={campaignTemplateId} onChange={(e) => setCampaignTemplateId(e.target.value)}>
                <option value="">Select a template…</option>
                {campaigns.length > 0 && (
                  <optgroup label="My campaigns">
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.variants.length} variant{c.variants.length === 1 ? "" : "s"})
                      </option>
                    ))}
                  </optgroup>
                )}
                {templates.length > 0 && (
                  <optgroup label="Ready-made templates">
                    {templates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.variants.length} variant{c.variants.length === 1 ? "" : "s"})
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
              <p className="mt-2 text-xs text-fg-muted">
                Each run clones this template's subject/body into its own campaign. Build your own on the Campaigns tab, or pick a ready-made one.
              </p>
            </div>
          )}

          {step === 3 && (
            <div>
              <Label>Sending mailboxes</Label>
              <div className="flex flex-wrap gap-2">
                {mailboxes.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggleMailbox(m.id)}
                    className={`rounded-lg border px-3 py-2 text-sm ${mailboxSelections.has(m.id) ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300" : "border-border"}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-fg-muted">
                {mailboxes.length === 0
                  ? "Add a mailbox on the Campaigns tab before creating an automation."
                  : "Mail will rotate across the selected senders with your campaign's rotation cadence."}
              </p>
            </div>
          )}

          {step === 4 && (
            <div className="flex flex-col gap-4">
              <Label>Trigger</Label>
              <div className="flex gap-2">
                {(["manual", "daily"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTriggerMode(t)}
                    className={`rounded-lg border px-3 py-2 text-sm ${triggerMode === t ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300" : "border-border"}`}
                  >
                    {t === "manual" ? "Manual" : "Daily"}
                  </button>
                ))}
              </div>
              {triggerMode === "daily" && (
                <div className="flex items-center gap-2">
                  <Label className="mb-0">Run at</Label>
                  <Select value={scheduleHour} onChange={(e) => setScheduleHour(Number(e.target.value))} className="w-auto">
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, "0")}:00 UTC
                      </option>
                    ))}
                  </Select>
                  <span className="text-xs text-fg-muted">Sends still require your confirmation.</span>
                </div>
              )}
            </div>
          )}

          {formError && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{formError}</p>}

          <div className="mt-5 flex items-center justify-between">
            <Button type="button" variant="ghost" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
              Back
            </Button>
            {step < 4 ? (
              <Button type="button" onClick={() => setStep((s) => Math.min(4, s + 1))}>
                Next
              </Button>
            ) : (
              <Button type="button" onClick={() => void submitForm()} disabled={creating}>
                {creating ? "Saving…" : editTarget ? "Save changes" : "Create automation"}
              </Button>
            )}
          </div>
        </Card>
      )}
        </div>

        <aside className="sticky top-6 flex flex-col gap-3">
          <Card className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Ask the agent</h2>
              {mailboxCount > 0 ? (
                <Badge tone="neutral">
                  {mailboxCount} mailbox{mailboxCount === 1 ? "" : "es"}
                </Badge>
              ) : (
                <Badge tone="warning">No mailboxes</Badge>
              )}
            </div>
            <p className="text-xs text-fg-muted">
              Describe the audience you need leads for. The agent drafts a plan you review — nothing runs until you confirm it.
            </p>

            {/* Message bubbles */}
            <div className="flex max-h-80 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-bg p-3">
              {agentMessages.filter((m) => m.role === "user" || m.role === "assistant").length === 0 && (
                <p className="text-xs text-fg-muted">No messages yet — try &quot;find leads for AI app founders in the US&quot;.</p>
              )}
              {agentMessages
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m) => (
                  <div
                    key={m.id}
                    className={`max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                      m.role === "user"
                        ? "ml-auto bg-brand-600 text-white"
                        : "border border-border bg-bg-elevated"
                    }`}
                  >
                    {m.content || "—"}
                  </div>
                ))}
              {agentSending && (
                <div className="flex max-w-[90%] items-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-fg-muted">
                  <Spinner className="h-3.5 w-3.5" /> The agent is thinking…
                </div>
              )}
            </div>

            {/* Pending (unconfirmed) plan cards */}
            {agentPending.map((action) => (
              <div key={action.id} className="flex flex-col gap-2 rounded-xl border border-border bg-bg p-3">
                <div className="flex items-center gap-2">
                  <Badge tone="warning">{action.kind === "job" ? "Job plan" : "Campaign plan"}</Badge>
                  <span className="text-xs text-fg-muted">
                    expires {new Date(action.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                {action.proposal && <p className="text-sm text-fg">{action.proposal}</p>}
                {action.kind === "job" ? (
                  <JobPlanDetails payload={action.payload} />
                ) : (
                  <CampaignPlanDetails payload={action.payload} />
                )}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={() => void approveAction(action)}
                    disabled={agentBusyId === action.id}
                  >
                    {agentBusyId === action.id ? <Spinner className="h-3.5 w-3.5" /> : null}
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => void rejectAction(action)}
                    disabled={agentBusyId === action.id}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            ))}

            {/* Executed outcomes + campaign follow-up */}
            {Object.entries(agentOutcomes).map(([id, view]) => (
              <AgentOutcomeCard
                key={id}
                view={view}
                mailboxCount={mailboxCount}
                onPlanCampaign={planCampaignFollowUp}
              />
            ))}

            {/* Composer */}
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void sendAgentMessage();
              }}
            >
              <div ref={agentInputRef}>
                <Input
                  value={agentInput}
                  onChange={(e) => setAgentInput(e.target.value)}
                  disabled={agentSending}
                  placeholder="e.g. up to 10,000 leads for AI apps outreach"
                />
              </div>
              <Button type="submit" disabled={agentSending || agentInput.trim().length === 0}>
                {agentSending ? "Sending…" : "Send"}
              </Button>
            </form>
          </Card>
        </aside>
      </div>
    </div>
  );
}

// --- Task 31, item 3 — small presentational pieces for the agent chat panel ---
function JobPlanDetails({ payload }: { payload: Record<string, unknown> }) {
  const findTerms = payloadArr(payload, "find_terms");
  const locationTerms = payloadArr(payload, "location_terms");
  const emailDomains = payloadArr(payload, "email_domains");
  const minResults = payloadNum(payload, "min_results");
  const maxDuration = payloadNum(payload, "max_duration_minutes");
  const estimatedMin = payloadNum(payload, "estimated_time_minutes");
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs font-medium text-fg-muted">Find:</span>
        {findTerms.length === 0 ? (
          <span className="text-fg-muted">—</span>
        ) : (
          findTerms.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))
        )}
      </div>
      {locationTerms.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs font-medium text-fg-muted">Location:</span>
          {locationTerms.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      )}
      {emailDomains.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs font-medium text-fg-muted">Domains:</span>
          {emailDomains.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      )}
      <p className="text-xs text-fg-muted">
        {minResults && minResults > 0 ? `${minResults.toLocaleString()} result${minResults === 1 ? "" : "s"} target` : "No result target"}
        {estimatedMin ?? maxDuration ? ` · ~${estimatedMin ?? maxDuration} min` : ""}
      </p>
    </div>
  );
}

function CampaignPlanDetails({ payload }: { payload: Record<string, unknown> }) {
  const name = payloadStr(payload, "name");
  const subject = payloadStr(payload, "subject");
  const body = payloadStr(payload, "body_html");
  const jobId = payloadStr(payload, "search_job_id");
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {name && <p className="font-medium">{name}</p>}
      {jobId && <p className="break-all text-xs text-fg-muted">Job: {jobId}</p>}
      {subject && (
        <p className="text-xs text-fg-muted">
          <span className="font-medium">Subject:</span> {subject}
        </p>
      )}
      {body && (
        <p className="line-clamp-3 text-xs text-fg-muted">
          {body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}
        </p>
      )}
    </div>
  );
}

function AgentOutcomeCard({
  view,
  mailboxCount,
  onPlanCampaign,
}: {
  view: AgentOutcomeView;
  mailboxCount: number;
  onPlanCampaign: (jobId: string) => void;
}) {
  if (view.phase === "pending") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-bg p-3 text-sm text-fg-muted">
        <Spinner className="h-3.5 w-3.5" /> Executing…
      </div>
    );
  }
  if (view.phase === "rejected") {
    return (
      <div className="rounded-xl border border-border bg-bg p-3 text-sm text-fg-muted">Proposal rejected.</div>
    );
  }
  if (view.phase === "error" || !view.outcome) {
    return (
      <div className="rounded-xl border border-border bg-bg p-3 text-sm text-fg-muted">Couldn&apos;t load the outcome.</div>
    );
  }

  const o = view.outcome;
  if (o.kind === "campaign") {
    return (
      <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-bg p-3 text-sm">
        <Badge tone="success">Campaign created</Badge>
        {o.campaign?.id && (
          <p className="break-all text-xs text-fg-muted">{o.campaign.id}</p>
        )}
      </div>
    );
  }

  const job = o.job;
  const done = job ? !jobStillWorking(job.status) : false;
  const req = view.requestedLeads;
  const pct =
    job && req && req > 0 && job.ledCount > 0 ? Math.round((job.ledCount / req) * 100) : undefined;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-bg p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge tone={done ? (job?.status === "done" ? "success" : "danger") : "neutral"}>
          {job?.status ?? "executed"}
        </Badge>
        {job && jobStillWorking(job.status) && <Spinner className="h-3.5 w-3.5" />}
      </div>
      {job && (
        <>
          <p className="text-fg">
            {job.ledCount.toLocaleString()} leads found
            {req && req > 0
              ? ` vs ${req.toLocaleString()} requested${pct !== undefined ? ` (${pct}%)` : ""}`
              : ""}
          </p>
          <p className="text-xs text-fg-muted">
            {job.validCount} valid · {job.invalidCount} invalid · {job.uncheckedCount} unchecked
          </p>
        </>
      )}
      {done && mailboxCount > 0 && (
        <Button
          type="button"
          variant="secondary"
          disabled={!o.executedJobId}
          onClick={() => onPlanCampaign(o.executedJobId!)}
        >
          Plan a follow-up campaign
        </Button>
      )}
    </div>
  );
}