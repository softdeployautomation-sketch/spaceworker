// Shared SSE client controllers for Cline MCP server.
// Keyed by clientId so the message route can write back to SSE clients.
import type { ReadableStreamDefaultController } from "node:stream/web";

export const sseControllers = new Map<
  string,
  { controller: ReadableStreamDefaultController; encoder: TextEncoder }
>();