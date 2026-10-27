import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { sseControllers } from "@/lib/clin/mcp-sse";

export const dynamic = "force-dynamic";
export const maxDuration = 300;



export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const clientId = crypto.randomUUID();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      sseControllers.set(clientId, { controller, encoder });

      // Send the MCP endpoint event so the client knows where to POST messages
      const endpointEvent = `event: endpoint\ndata: /api/clin/mcp/message?clientId=${clientId}\n\n`;
      controller.enqueue(encoder.encode(endpointEvent));

      // Heartbeat every 30 seconds
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`event: heartbeat\ndata: {}\n\n`));
        } catch {
          // connection closed
        }
      }, 30000);

      return () => {
        clearInterval(heartbeat);
        sseControllers.delete(clientId);
      };
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

export { sseControllers };