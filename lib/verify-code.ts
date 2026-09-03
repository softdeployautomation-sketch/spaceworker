import "server-only";
import { randomInt } from "crypto";
import { hash, compare } from "bcrypt";
import { db } from "./db";

export async function issueVerificationCode(email: string): Promise<string> {
  // Generate a 6-digit code
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  const hashedCode = await hash(code, 10);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  // Find or create unverified user (for signup flow)
  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error("User not found");
  }

  // Delete old codes for this user and create new one
  await db.verificationCode.deleteMany({ where: { userId: user.id } });
  await db.verificationCode.create({
    data: {
      userId: user.id,
      codeHash: hashedCode,
      expiresAt,
    },
  });

  return code;
}

export async function consumeVerificationCode(email: string, code: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) return false;

  const record = await db.verificationCode.findFirst({
    where: { userId: user.id },
  });

  if (!record || record.expiresAt < new Date() || record.consumedAt) {
    return false;
  }

  const isValid = await compare(code, record.codeHash);
  if (!isValid) {
    // Increment attempts for brute force protection
    await db.verificationCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    return false;
  }

  await db.verificationCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });

  return true;
}
