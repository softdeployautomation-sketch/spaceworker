import "server-only";
import type { Prisma } from "@prisma/client";

// Never select/return dirPath — it's an absolute server path.
export const PROFILE_SAFE_SELECT = {
  id: true,
  name: true,
  status: true,
  lastUsedAt: true,
  createdAt: true,
} as const satisfies Prisma.BrowserProfileSelect;