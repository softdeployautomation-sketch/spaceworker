import "server-only";
import type { Prisma } from "@prisma/client";

// Never select/return dirPath or any proxy credential (byoProxyAuth).
// nekoPassword IS selected here (needed server-side to build connectUrl's
// ?pwd= param in browser-session-serialize.ts) but must never be returned
// as its own bare field in a JSON response.
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
  nekoPassword: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
} as const satisfies Prisma.BrowserSessionSelect;