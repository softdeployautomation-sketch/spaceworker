"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, Card, Input, Label } from "@/components/ui";

interface ClineSettings {
  clineModelId: string | null;
  clineApiEndpoint: string | null;
  updatedAt: string | null;
}

interface ClineAuth {
  connected: boolean;
  email: string | null;
  accountId: string | null;
  modelId: string | null;
  apiEndpoint: string | null;
  updatedAt: string | null;
}

interface FreeModel {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export function ClineSettingsCard() {
  const [settings, setSettings] = useState<ClineSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiEndpoint, setApiEndpoint] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [auth, setAuth] = useState<ClineAuth | null>(null);
  const [freeModels, setFreeModels] = useState<FreeModel[]>([]);
  const [loadingFree, setLoadingFree] = useState(false);
  const [loginPending, setLoginPending] = useState<{ deviceCode: string; userCode: string; verificationUri: string; pollIntervalSeconds: number } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [pollTimer, setPollTimer] = useState<ReturnType<typeof setInterval> | null>(null);


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

  const loadAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/clin/auth/me", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setAuth({
        connected: data.connected ?? false,
        email: data.email ?? null,
        accountId: data.accountId ?? null,
        modelId: data.modelId ?? null,
        apiEndpoint: data.apiEndpoint ?? null,
        updatedAt: data.updatedAt ?? null,
      });
    } catch {
      // swallow
    }
  }, []);

  const loadFreeModels = useCallback(async () => {
    setLoadingFree(true);
    try {
      const res = await fetch("/api/clin/models/free", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setFreeModels((data.free ?? []).map((m: any) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        tags: m.tags ?? [],
      })));
    } catch {
      // swallow
    } finally {
      setLoadingFree(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadSettings();
      await loadAuth();
      await loadFreeModels();
    })();
  }, [loadSettings, loadAuth, loadFreeModels]);

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
  }, [apiKey, modelId, apiEndpoint, loadSettings, loadAuth]);

  const startPolling = (deviceCode: string, intervalMs: number) => {
    if (pollTimer) clearInterval(pollTimer);
    const timer = setInterval(async () => {
      await loadAuth();
      if (auth?.connected) {
        clearInterval(timer);
        setPollTimer(null);
        setLoginPending(null);
        setError("");
      }
    }, intervalMs);
    setPollTimer(timer);
  };

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      setPollTimer(null);
    }
  };

  const handleLogin = async () => {
    setError("");
    stopPolling();
    try {
      const res = await fetch("/api/clin/auth/login", { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "Failed to start login");
        return;
      }
      const data = await res.json();
      if (data.alreadyConnected) {
        setError("Cline account already connected. Log out first to connect a different account.");
        await loadAuth();
        return;
      }
      setLoginPending({
        deviceCode: data.deviceCode,
        userCode: data.userCode,
        verificationUri: data.verificationUri,
        pollIntervalSeconds: data.pollIntervalSeconds ?? 5,
      });
      // Start auto-polling so connection updates without manual refresh
      startPolling(data.deviceCode, (data.pollIntervalSeconds ?? 5) * 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login_failed");
    }
  };

  const confirmLogin = async (deviceCode: string) => {
    setError("");
    setConnecting(true);
    try {
      const res = await fetch("/api/clin/auth/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to confirm login");
        setConnecting(false);
        return;
      }
      await loadAuth();
      setConnecting(false);
      stopPolling();
      setLoginPending(null);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "confirm_failed");
      setConnecting(false);
    }
  };

  const handleLogout = async () => {
    setError("");
    stopPolling();
    setLoginPending(null);
    try {
      const res = await fetch("/api/clin/auth/logout", { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "Failed to log out");
        return;
      }
      await loadAuth();
      await loadSettings();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "logout_failed");
    }
  };

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

      {/* Auth status section */}
      <div className="mb-6 p-4 rounded-lg border bg-muted/50">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="text-sm font-medium text-fg">Cline Account</h3>
            <p className="text-xs text-fg-muted">
              {auth?.connected
                ? `Connected via Cline OAuth (free tier)${auth.email ? ` — ${auth.email}` : ""}`
                : "Not connected — manual API key required"}
            </p>
          </div>
          <div className="flex gap-2">
            {auth?.connected ? (
              <Button variant="ghost" onClick={handleLogout} disabled={saving}>
                Log out
              </Button>
            ) : (
              <Button onClick={handleLogin} disabled={saving}>
                {saving ? "Starting…" : "Log in to Cline"}
              </Button>
            )}
          </div>
        </div>

        {auth && (
          <div className="grid gap-3 md:grid-cols-4 text-sm">
            {auth.email && (
              <div className="flex items-center gap-2 p-2 rounded bg-fg/10">
                <span className="text-xs text-fg-muted">Account</span>
                <span className="text-xs font-medium text-fg truncate" title={auth.email}>
                  {auth.email}
                </span>
              </div>
            )}
            {auth.accountId && (
              <div className="flex items-center gap-2 p-2 rounded bg-fg/10">
                <span className="text-xs text-fg-muted">Account ID</span>
                <span className="text-xs font-medium text-fg truncate" title={auth.accountId}>
                  {auth.accountId}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 p-2 rounded bg-fg/10">
              <span className="text-xs text-fg-muted">Status</span>
              <span className={`text-xs font-medium ${auth.connected ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                {auth.connected ? "Connected" : "Disconnected"}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Login pending: waiting for user to complete device auth */}
      {loginPending && (
        <div className="mb-6 p-4 rounded-lg border border-blue-500/50 bg-blue-500/10">
          <h3 className="text-sm font-medium text-fg">Complete Cline Login</h3>
          <p className="mt-1 text-sm text-fg">
            1. Visit:{" "}
            <span className="font-mono text-xs break-all text-fg">{loginPending.verificationUri}</span><br />
            2. Enter code:{" "}
            <span className="font-mono text-xs font-bold text-blue-600">{loginPending.userCode}</span>
          </p>
          <p className="mt-2 text-xs text-fg-muted">
            After verifying on Cline, click "Confirm Connected" to auto-connect. The page will also poll automatically every {loginPending.pollIntervalSeconds}s.
          </p>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => confirmLogin(loginPending.deviceCode)} disabled={connecting}>
              {connecting ? "Confirming…" : "Confirm Connected"}
            </Button>
            <Button variant="ghost" onClick={() => { stopPolling(); setLoginPending(null); }}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Settings form */}
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
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} className="w-full border rounded px-2 py-1 text-sm">
            <option value="">Select a free model…</option>
            {freeModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.id}) — {m.tags.join(", ")}
              </option>
            ))}
          </select>
          <p className="text-xs text-fg-muted">Cline free-tier model (loaded live)</p>
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