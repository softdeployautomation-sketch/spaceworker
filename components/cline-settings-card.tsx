"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, Card, Input, Label } from "@/components/ui";

interface ClineSettings {
  clineModelId: string | null;
  clineApiEndpoint: string | null;
  updatedAt: string | null;
}

export function ClineSettingsCard() {
  const [settings, setSettings] = useState<ClineSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiEndpoint, setApiEndpoint] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/cyberlab/agent/settings", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data.settings ?? null);
      if (data.settings?.clineModelId) setModelId(data.settings.clineModelId);
      if (data.settings?.clineApiEndpoint) setApiEndpoint(data.settings.clineApiEndpoint);
    } catch {
      // swallow
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadSettings();
    })();
  }, [loadSettings]);

  const save = useCallback(async () => {
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      const res = await fetch("/api/cyberlab/agent/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clineApiKey: apiKey.trim() || undefined,
          clineModelId: modelId.trim() || undefined,
          clineApiEndpoint: apiEndpoint.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "Failed to save");
        setSaving(false);
        return;
      }
      setSaved(true);
      setApiKey("");
      await loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save_failed");
    } finally {
      setSaving(false);
    }
  }, [apiKey, modelId, apiEndpoint, loadSettings]);

  return (
    <Card className="max-w-2xl p-6">
      <div className="flex items-start justify-between gap-2 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-fg">Cline Agent (Cyber Lab)</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Configure the Cline API key, model, and endpoint used by Cyber Lab agent sessions. Cline free tier models are supported — no GPU spend required.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label>Cline API key</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-… or Cline free-tier key"
            className="w-full"
          />
          <p className="text-xs text-fg-muted">
            Stored server-side. Only the hash is ever returned to the client.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label>Model</Label>
          <Input
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder="claude-sonnet-4-6"
            className="w-full"
          />
          <p className="text-xs text-fg-muted">Cline free-tier model id</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label>Endpoint (optional)</Label>
          <Input
            value={apiEndpoint}
            onChange={(e) => setApiEndpoint(e.target.value)}
            placeholder="https://api.cline.com"
            className="w-full"
          />
          <p className="text-xs text-fg-muted">Leave blank for Cline default</p>
        </div>
      </div>

      {settings && (
        <div className="mt-4 flex items-center justify-between gap-2 text-sm text-fg-muted">
          <span>Model: {settings.clineModelId ?? "default"}</span>
          <span>Endpoint: {settings.clineApiEndpoint ?? "default"}</span>
          <span>Updated: {settings.updatedAt ? new Date(settings.updatedAt).toLocaleString() : "never"}</span>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-6 flex gap-2">
        <Button
          onClick={save}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save Cline settings"}
        </Button>
        {saved && <span className="text-xs text-fg-muted">Saved.</span>}
      </div>
    </Card>
  );
}