import "server-only";

import crypto from "node:crypto";

import { env } from "./env";

// Task 94 — signed, single-use*, short-TTL (15 min) tokens backing the
// Approve/Reject/Review links a Telegram push carries. *Single-use is
// enforced by the BOUND ACTION's own atomic pending->approved/rejected
// transition (already how every approval path in this repo works — a second
// approve/reject on an already-decided AgentPendingAction hits a 0-row
// update and 409s), not by a separate token ledger: the token only ever
// proves "this really is a signed link for this action, not forged or
// stale" — the one-time enforcement is the row's own state machine.
//
// No new env var: the HMAC key is derived from the existing SESSION_SECRET
// (already required, already a real secret) plus a fixed namespace string,
// so there is nothing new to configure or accidentally leave unset on the
// VPS.

const TOKEN_TTL_MS = 15 * 60 * 1000;

export type ApprovalDecision = "approve" | "reject" | "review";

function hmacKey(): Buffer {
  return crypto.createHash("sha256").update(`${env.sessionSecret}:agent-approval-v1`).digest();
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", hmacKey()).update(payload).digest("base64url");
}

/** `<base64url(pendingActionId.decision.expiresAt)>.<hmac>` — long, fine for a URL button. */
export function mintApprovalToken(pendingActionId: string, decision: ApprovalDecision): string {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${pendingActionId}.${decision}.${expiresAt}`;
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  return `${payloadB64}.${sign(payload)}`;
}

export interface ParsedApprovalToken {
  pendingActionId: string;
  decision: ApprovalDecision;
}

/** Constant-time signature check + expiry. Malformed/forged/expired => null, never throws. */
export function parseApprovalToken(token: string): ParsedApprovalToken | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const suppliedSig = token.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const expectedSig = sign(payload);
  const a = Buffer.from(suppliedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  const [pendingActionId, decision, expiresAtRaw] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!pendingActionId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  if (decision !== "approve" && decision !== "reject" && decision !== "review") return null;

  return { pendingActionId, decision };
}
