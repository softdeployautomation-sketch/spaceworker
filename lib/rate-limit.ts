import "server-only";
import { prisma } from "./prisma";

export function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export async function allowAndRecord(
  ip: string, kind: string, maxCount: number, windowMs: number
): Promise<boolean> {
  const since = new Date(Date.now() - windowMs);
  const count = await prisma.rateLimitEvent.count({
    where: { ip, kind, createdAt: { gte: since } },
  });
  if (count >= maxCount) return false;
  await prisma.rateLimitEvent.create({ data: { ip, kind } });
  return true;
}

export const checkSignup = (ip: string) => allowAndRecord(ip, "signup", 5, 3_600_000);
export const checkLogin  = (ip: string) => allowAndRecord(ip, "login",  10, 3_600_000);
export const checkVerify = (ip: string) => allowAndRecord(ip, "verify", 10, 3_600_000);
export const checkResend = (ip: string) => allowAndRecord(ip, "resend", 3, 3_600_000);