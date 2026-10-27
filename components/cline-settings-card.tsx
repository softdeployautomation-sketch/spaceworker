"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  expires: number | null;
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

interface FreeModelResponse {
  id?: string;
  name?: string;
  description?: string;
  tags?: string[];
}

interface ConnectPayload {
  email?: string | null;
  accountId?: string | null;
  expires?: number | null;
}

interface LoginPending {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  pollIntervalSeconds: number;
  /** Epoch ms — the WorkOS code stops working here. */
  expiresAt: number;
}

const EMPTY_AUTH: ClineAuth = {
  connected: false,
  email: null,
  accountId: null,
  expires: null,
  modelId: null,
  apiEndpoint: null,
  updatedAt: null,
};

export function ClineSettingsCard() {
  const [settings, setSettings] = useState<ClineSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiEndpoint, setApiEndpoint] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [pendingNotice, setPendingNotice] = useState("");
  const [auth, setAuth] = useState<ClineAuth | null>(null);
  const [freeModels, setFreeModels] = useState<FreeModel[]>([]);
  const [loadingFree, setLoadingFree] = useState(false);
  const [loginPending, setLoginPending] = useState<LoginPending | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollInFlightRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

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
        expires: data.expires ?? null,
        modelId: data.modelId ?? null,
        apiEndpoint: data.apiEndpoint ?? null,
        updatedAt: data.updatedAt ?? null,
      });
      if (data.needsReconnect && data.message) {
        setError(data.message);
      }
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
      setFreeModels(
        ((data.free ?? []) as FreeModelResponse[]).map((m) => ({
          id: m.id ?? "",
          name: m.name ?? m.id ?? "Free model",
          description: m.description ?? "",
          tags: m.tags ?? [],
        })),
      );
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

  // Tick once a second so the pending panel can show a real countdown.
  useEffect(() => {
    if (!loginPending) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [loginPending]);

  // A code past its WorkOS TTL can never succeed: stop the spinner and tell the
  // user to get a new one instead of polling a dead code until the page dies.
  useEffect(() => {
    if (!loginPending) return;
    const ms = Math.max(0, loginPending.expiresAt - Date.now());
    const timer = setTimeout(() => {
      stopPolling();
      setLoginPending(null);
      setPendingNotice("");
      setError("This Cline code expired. Start the login again to get a new code.");
    }, ms + 1500);
    return () => clearTimeout(timer);
  }, [loginPending, stopPolling]);

  const applyConnected = useCallback(
    async (data: ConnectPayload) => {
      setLoginPending(null);
      setPendingNotice("");
      setError("");
      setSaved(true);
      setAuth({
        connected: true,
        email: data.email ?? null,
        accountId: data.accountId ?? null,
        expires: data.expires ?? null,
        modelId: null,
        apiEndpoint: null,
        updatedAt: new Date().toISOString(),
      });
      await loadAuth();
      await loadFreeModels();
    },
    [loadAuth, loadFreeModels],
  );

  /**
   * TASK_246 — the client that actually connects.
   *
   * The old loop only read /me (a DB read) and the only code that talked to
   * Cline was the manual Confirm. This loop posts to /poll, which exchanges the
   * device code server-side; sequential setTimeout (never setInterval) so two
   * requests can never race the one-time code.
   */
  useEffect(() => {
    if (!loginPending) return;
    const deviceCode = loginPending.deviceCode;
    let cancelled = false;

    function schedule(delayMs: number) {
      if (cancelled) return;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = setTimeout(tick, delayMs);
    }

    async function tick() {
      if (cancelled) return;
      if (pollInFlightRef.current) {
        schedule(2000);
        return;
      }
      pollInFlightRef.current = true;
      try {
        const res = await fetch("/api/clin/auth/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode, windowSeconds: 6 }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (res.ok && (data.connected || data.ok)) {
          await applyConnected(data);
          return;
        }

        if (res.status === 202) {
          setPendingNotice("Waiting for approval on Cline…");
          schedule((Number(data.retryAfterSeconds) || 5) * 1000);
          return;
        }

        if (res.status === 410 || res.status === 403) {
          stopPolling();
          setLoginPending(null);
          setPendingNotice("");
          setError(data.error || "This Cline login is no longer valid. Start again.");
          return;
        }

        if (res.status === 502) {
          setPendingNotice("Could not reach Cline. Retrying…");
          schedule((Number(data.retryAfterSeconds) || 5) * 1000);
          return;
        }

        if (res.status === 401) {
          stopPolling();
          setLoginPending(null);
          setError("Your session expired. Reload the page and log in again.");
          return;
        }

        schedule(5000);
      } catch {
        if (!cancelled) {
          setPendingNotice("Network hiccup — retrying…");
          schedule(5000);
        }
      } finally {
        pollInFlightRef.current = false;
      }
    }

    schedule(1500);
    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginPending?.deviceCode]);

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

  const handleLogin = useCallback(async () => {
    setError("");
    setPendingNotice("");
    setSaved(false);
    stopPolling();
    setConnecting(true);
    try {
      const res = await fetch("/api/clin/auth/login", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to start login");
        return;
      }
      if (data.alreadyConnected) {
        await loadAuth();
        return;
      }
      const ttlSeconds = Number(data.expiresInSeconds) || 300;
      setLoginPending({
        deviceCode: data.deviceCode,
        userCode: data.userCode,
        verificationUri: data.verificationUri,
        pollIntervalSeconds: data.pollIntervalSeconds ?? 5,
        expiresAt: Date.parse(data.expiresAt) || Date.now() + ttlSeconds * 1000,
      });
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "login_failed");
    } finally {
      setConnecting(false);
    }
  }, [stopPolling, loadAuth]);

  const confirmLogin = useCallback(
    async (deviceCode: string) => {
      setError("");
      setConnecting(true);
      try {
        // Immediate check (15s window) — the "I already approved it" button.
        const res = await fetch("/api/clin/auth/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode, windowSeconds: 15 }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.connected) {
          await applyConnected(data);
          return;
        }
        if (res.status === 202) {
          setPendingNotice("Not approved yet — approve the code on Cline and this panel will connect automatically.");
          return;
        }
        if (res.status === 410 || res.status === 403) {
          stopPolling();
          setLoginPending(null);
          setError(data.error || "This Cline login is no longer valid. Start again.");
          return;
        }
        if (res.status === 502) {
          setPendingNotice(data.error || "Could not reach Cline. Retrying…");
          return;
        }
        setError(data.error || "Failed to confirm login");
      } catch (err) {
        setError(err instanceof Error ? err.message : "confirm_failed");
      } finally {
        setConnecting(false);
      }
    },
    [applyConnected, stopPolling],
  );

  const handleLogout = useCallback(async () => {
    setError("");
    setPendingNotice("");
    setConnecting(true);
    stopPolling();
    try {
      const res = await fetch("/api/clin/auth/logout", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || "Failed to log out");
        return;
      }
      setAuth({ ...EMPTY_AUTH });
      setLoginPending(null);
      await loadAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "logout_failed");
    } finally {
      setConnecting(false);
    }
  }, [stopPolling, loadAuth]);

  const connected = auth?.connected ?? false;
  const secondsLeft = loginPending
    ? Math.max(0, Math.ceil((loginPending.expiresAt - now) / 1000))
    : 0;
  const minutesLeft = Math.floor(secondsLeft / 60);
  const restSeconds = secondsLeft % 60;

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
              Approve the code on Cline. This panel connects automatically — no need to press
              anything. Code expires in {minutesLeft}:{String(restSeconds).padStart(2, "0")}.
            </p>
            {pendingNotice && <p className="mt-1 text-xs text-blue-600">{pendingNotice}</p>}
            <div className="mt-4 flex gap-2">
              <Button
                type="button"
                onClick={() => confirmLogin(loginPending.deviceCode)}
                disabled={connecting}
              >
                {connecting ? "Checking…" : "Check now"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  stopPolling();
                  setLoginPending(null);
                  setPendingNotice("");
                }}
              >
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
              Optional. The Cline login above is used when no key is entered here.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Model</Label>
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="w-full border rounded px-2 py-1 text-sm"
              disabled={loadingFree}
            >
              <option value="">Select a free model…</option>
              {freeModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.id}) — {m.tags.join(", ")}
                </option>
              ))}
            </select>
            <p className="text-xs text-fg-muted">
              {loadingFree ? "Loading free models…" : "Cline free-tier model (loaded live)"}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Endpoint (optional)</Label>
            <Input
              value={apiEndpoint}
              onChange={(e) => setApiEndpoint(e.target.value)}
              placeholder="https://api.cline.bot"
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
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save Cline settings"}
          </Button>
          {saved && <span className="text-xs text-fg-muted">Saved.</span>}
        </div>
      </div>
    </Card>
  );
}
