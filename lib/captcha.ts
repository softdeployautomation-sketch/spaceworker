import "server-only";

import { createHash, randomBytes } from "crypto";

import { prisma } from "@/lib/prisma";
import { seededTargets } from "./captcha-seed";

const GRID_SIZE = 9;
const TARGET_MIN = 2;
const TARGET_MAX = 5;
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type CaptchaChallengeView = {
  token: string;
  seed: string;
  targetCount: number;
};

export async function createCaptchaChallenge(): Promise<CaptchaChallengeView> {
  const token = randomBytes(16).toString("hex");
  const seed = randomBytes(16).toString("hex");
  const targetCount = TARGET_MIN + Math.floor(Math.random() * (TARGET_MAX - TARGET_MIN + 1));
  const targets = seededTargets(seed, GRID_SIZE, targetCount);
  const answerHash = createHash("sha256").update(targets.join(",")).digest("hex");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  await prisma.captchaChallenge.create({
    data: { token, answerHash, expiresAt },
  });

  return { token, seed, targetCount };
}

/** Verify a submitted CAPTCHA answer. One-time use, expiry-enforced. */
export async function verifyCaptcha(token: string, selected: number[]): Promise<boolean> {
  const now = new Date();
  const challenge = await prisma.captchaChallenge.findUnique({ where: { token } });
  if (!challenge) return false;
  if (challenge.used) return false;
  if (challenge.expiresAt < now) return false;

  const answer = selected.slice().sort((a, b) => a - b).join(",");
  const answerHash = createHash("sha256").update(answer).digest("hex");
  if (answerHash !== challenge.answerHash) return false;

  await prisma.captchaChallenge.update({ where: { token }, data: { used: true } });
  return true;
}
