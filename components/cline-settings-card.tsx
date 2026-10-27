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

interface LoginPending {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  pollIntervalSeconds: number;
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
  const [loginPending, setLoginPending] = useState<LoginPending | null>(null);
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

  const stopPolling = useCallback(() => {
    if (pollTimer) {
      clearInterval(pollTimer);
      setPollTimer(null);
    }
  }, [pollTimer]);

  // Read-only auto-poller: checks /api/clin/auth/me so tokens appear without
  // mutating server state. Runs only while loginPending is set.
  useEffect(() => {
    if (!loginPending) return;

    const intervalMs = loginPending.pollIntervalSeconds * 1000;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/clin/auth/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (data.connected) {
          clearInterval(timer);
          setPollTimer(null);
          setLoginPending(null);
          setError("");
          setAuth({
            connected: true,
            email: data.email ?? null,
            accountId: data.accountId ?? null,
            modelId: data.modelId ?? null,
            apiEndpoint: data.apiEndpoint ?? null,
            updatedAt: data.updatedAt ?? null,
          });
        }
      } catch {
        // keep polling
      }
    }, intervalMs);

    setPollTimer(timer);
    return () => clearInterval(timer);
  }, [loginPending]);

  const handleLogin = useCallback(async () => {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "login_failed");
    }
  }, [stopPolling, loadAuth]);

  const confirmLogin = useCallback(async (deviceCode: string) => {
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
  }, [stopPolling, loadAuth]);

  const handleLogout = useCallback(async () => {
    setError("");
    setConnecting(true);
    stopPolling();
    try {
      const res = await fetch("/api/clin/auth/logout", { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "Failed to log out");
        setConnecting(false);
        return;
      }
      setAuth({ connected: false, email: null, accountId: null, modelId: null, apiEndpoint: null, updatedAt: null });
      setLoginPending(null);
      setConnecting(false);
      await loadAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "logout_failed");
      setConnecting(false);
    }
  }, [stopPolling, loadAuth]);

  const connected = auth?.connected ?? false;

  return (
    <Card>
      <div className="p-4">
        <h2 className="text-lg font-semibold mb-4 text-fg">Cline Free-Tier Connection</h2>

        {/* Auth status */}
        <div className="mb-4 flex items-center gap-2">
          {connected ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-100 text-green-700 text-xs font-medium">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              Connected: {auth?.email ?? auth?.accountId ?? "Cline account"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-100 text-red-700 text-xs font-medium">
              <span className="w-2 h-2 rounded-full bg-red-500"></span>
              Disconnected
            </span>
          )}
        </div>

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
              Verify on Cline, then click "Confirm Connected". The page will also auto-connect
              once you complete verification (no page refresh needed).
            </p>
            <div className="mt-4 flex gap-2">
              <Button onClick={() => confirmLogin(loginPending.deviceCode)} disabled={connecting}>
                {connecting ? "Confirming…" : "Confirm Connected"}
              </Button>
              <Button variant="ghost" onClick={() => { stopPolling(); setLoginPending(null); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {!connected && !loginPending && (
          <div className="mb-4">
            <Button onClick={handleLogin} disabled={connecting}>
              {connecting ? "Starting…" : "Log in to Cline"}
            </Button>
          </div>
        )}

        {connected && !loginPending && (
          <div className="mb-4 flex gap-2">
            <Button variant="ghost" onClick={handleLogout} disabled={connecting}>
              Log out / Switch account
            </Button>
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
      </div>
    </Card>
  );
}
