import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";

// A small, self-contained HMAC token — deliberately NOT the exe-license.ts
// scheme (that one's exact byte-for-byte format is load-bearing for an
// unrelated external Python validator; coupling this to it would just be
// confusing). Reuses SESSION_SECRET rather than adding a new required env
// var — one more secret to keep straight in the deploy playbook is exactly
// the class of thing that caused today's MAILBOX_ENCRYPTION_KEY incident.
function sign(payloadB64: string): string {
  return createHmac("sha256", env.sessionSecret).update(payloadB64, "utf8").digest("base64url");
}

// One real-world unsubscribe link per (user, email) pair — stable across every
// campaign of that user's to that address, so a recipient who gets a second
// campaign from the same sender later can still use an old link.
export function generateUnsubscribeToken(userId: string, email: string): string {
  const payload = `${userId}:${email.trim().toLowerCase()}`;
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifyUnsubscribeToken(token: string): { userId: string; email: string } | null {
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  const sep = payload.indexOf(":");
  if (sep < 0) return null;
  const userId = payload.slice(0, sep);
  const email = payload.slice(sep + 1);
  if (!userId || !email) return null;
  return { userId, email };
}
