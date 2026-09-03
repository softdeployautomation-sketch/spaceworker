import "server-only";
import type { Prisma } from "@prisma/client";

// Never select/return dirPath or any proxy credential (byoProxyAuth).
export const SESSION_SAFE_SELECT = {
  id: true,
  status: true,
  proxyMode: true,
  exitNodeId: true,
  byoProxyHost: true,
  byoProxyPort: true,
  byoProxyScheme: true,
  byoProxyUsername: true,
  containerId: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
} as const satisfies Prisma.BrowserSessionSelect;