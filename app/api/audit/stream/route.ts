import { subscribeLiveTrace } from "../../../../lib/agent-trace";

export const dynamic = "force-dynamic";

/**
 * Read-only real-time SSE stream for Agent Execution Trace Inspector.
 * Closing this stream (e.g. when user switches away from the Audit tab)
 * ONLY unsubscribes the read-only trace listener and NEVER cancels any LLM task.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const filterRunId = url.searchParams.get("runId")?.trim() || null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          cleanup();
        }
      };

      const unsub = subscribeLiveTrace((msg) => {
        if (filterRunId) {
          const msgRunId = msg.kind === "run" ? msg.run.run_id : msg.runId;
          if (msgRunId !== filterRunId) return;
        }
        send(msg);
      });

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsub();
        try {
          controller.close();
        } catch {}
      };

      request.signal.addEventListener("abort", cleanup, { once: true });

      // Send initial connected handshake
      send({ kind: "connected", timestamp: new Date().toISOString() });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
