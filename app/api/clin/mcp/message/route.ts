import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { z } from "zod";
import { startClineLabSession, sendClineMessage, stopClineSession, getClineSessionStatus } from "@/lib/lab/cline-agent";
import { sseControllers } from "@/lib/clin/mcp-sse";

export const dynamic = "force-dynamic";

const JsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.any().optional(),
});

const StartSessionParams = z.object({
  prompt: z.string(),
  modelId: z.string().optional(),
  targets: z.array(z.object({ kind: z.string(), value: z.string() })).optional(),
});

function jsonRpcResponse(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = new URL(req.url).searchParams.get("clientId");
  if (!clientId) {
    return NextResponse.json({ error: "clientId required" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = JsonRpcRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(jsonRpcError(null, -32700, "Parse error"), { status: 400 });
  }

  const { id, method, params } = parsed.data;

  try {
    switch (method) {
      case "initialize": {
        return NextResponse.json(jsonRpcResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "spaceworker-cyberlab", version: "1.0.0" },
        }));
      }

      case "tools/list": {
        return NextResponse.json(jsonRpcResponse(id, {
          tools: [
            {
              name: "cyberlab.start_session",
              description: "Start a Cyber Lab agent session (Cline) for offensive security testing",
              inputSchema: {
                type: "object",
                properties: {
                  prompt: { type: "string", description: "The security testing task/instruction" },
                  modelId: { type: "string", description: "Cline model ID (optional)" },
                  targets: {
                    type: "array",
                    description: "Attested targets the agent may operate on",
                    items: {
                      type: "object",
                      properties: { kind: { type: "string" }, value: { type: "string" } },
                      required: ["kind", "value"],
                    },
                  },
                },
                required: ["prompt"],
              },
            },
            {
              name: "cyberlab.send_message",
              description: "Send a message to an existing Cyber Lab agent session",
              inputSchema: {
                type: "object",
                properties: {
                  sessionId: { type: "string" },
                  prompt: { type: "string" },
                },
                required: ["sessionId", "prompt"],
              },
            },
            {
              name: "cyberlab.stop_session",
              description: "Stop a Cyber Lab agent session",
              inputSchema: {
                type: "object",
                properties: { sessionId: { type: "string" } },
                required: ["sessionId"],
              },
            },
            {
              name: "cyberlab.session_status",
              description: "Get the status of a Cyber Lab agent session",
              inputSchema: {
                type: "object",
                properties: { sessionId: { type: "string" } },
                required: ["sessionId"],
              },
            },
          ],
        }));
      }

      case "tools/call": {
        const callParams = z.object({ name: z.string(), arguments: z.any().optional() }).safeParse(params);
        if (!callParams.success) {
          return NextResponse.json(jsonRpcError(id, -32602, "Invalid tool call params"), { status: 400 });
        }
        const { name, arguments: args } = callParams.data;

        switch (name) {
          case "cyberlab.start_session": {
            const sp = StartSessionParams.safeParse(args);
            if (!sp.success) {
              return NextResponse.json(jsonRpcError(id, -32602, "Invalid start_session args"), { status: 400 });
            }
            const result = await startClineLabSession({
              userId: user.id,
              prompt: sp.data.prompt,
              modelId: sp.data.modelId,
              targets: sp.data.targets,
            });
            return NextResponse.json(jsonRpcResponse(id, result));
          }
          case "cyberlab.send_message": {
            const sm = z.object({ sessionId: z.string(), prompt: z.string() }).safeParse(args);
            if (!sm.success) {
              return NextResponse.json(jsonRpcError(id, -32602, "Invalid send_message args"), { status: 400 });
            }
            const result = await sendClineMessage(sm.data.sessionId, sm.data.prompt, user.id);
            return NextResponse.json(jsonRpcResponse(id, result));
          }
          case "cyberlab.stop_session": {
            const ss = z.object({ sessionId: z.string() }).safeParse(args);
            if (!ss.success) {
              return NextResponse.json(jsonRpcError(id, -32602, "Invalid stop_session args"), { status: 400 });
            }
            const result = await stopClineSession(ss.data.sessionId, user.id);
            return NextResponse.json(jsonRpcResponse(id, result));
          }
          case "cyberlab.session_status": {
            const ss = z.object({ sessionId: z.string() }).safeParse(args);
            if (!ss.success) {
              return NextResponse.json(jsonRpcError(id, -32602, "Invalid session_status args"), { status: 400 });
            }
            const result = await getClineSessionStatus(ss.data.sessionId, user.id);
            return NextResponse.json(jsonRpcResponse(id, result));
          }
          default:
            return NextResponse.json(jsonRpcError(id, -32601, `Method not found: ${name}`), { status: 400 });
        }
      }
      default:
        return NextResponse.json(jsonRpcError(id, -32601, `Method not found: ${method}`), { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      jsonRpcError(id, -32603, err instanceof Error ? err.message : "Internal error"),
      { status: 500 },
    );
  }
}