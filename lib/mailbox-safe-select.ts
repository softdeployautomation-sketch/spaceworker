import "server-only";
import type { Prisma } from "@prisma/client";

// Never select/return encryptedPassword, passwordIv or passwordTag.
export const MAILBOX_SAFE_SELECT = {
  id: true, label: true, host: true, port: true, username: true,
  fromAddress: true, secure: true, allowInsecure: true, dailyLimit: true, sentToday: true, sentTodayDate: true,
  active: true, lastTestedAt: true, lastTestOk: true, createdAt: true,
} as const satisfies Prisma.MailboxSelect;