import "server-only";
import type { Prisma } from "@prisma/client";

// Never select/return dirPath or decrypted proxy secrets (byoProxyAuth).
export const PROFILE_SAFE_SELECT = {
  id: true,
  name: true,
  status: true,
  byoProxyHost: true,
  byoProxyPort: true,
  byoProxyScheme: true,
  byoProxyUsername: true,
  lastUsedAt: true,
  createdAt: true,
} as const satisfies Prisma.BrowserProfileSelect;