import { NextRequest } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ChatSchema = z.object({
  conversationId: z.string().min(1),
  message: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const { runAgent } = await import("@/lib/agent");

  const body = await req.json();
  const { conversationId, message } = ChatSchema.safeParse(body).success
    ? ChatSchema.parse(body)
    : (() => {
        return { conversationId: "", message: "" }; // dummy para tipado; se corta abajo
      })();

  // si no válido, 400
  if (!conversationId || !message) {
    return new Response(JSON.stringify({ error: "conversationId y message son obligatorios" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const enc = new TextEncoder();
  const fmt = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown) => controller.enqueue(enc.encode(fmt(event, data)));
      try {
        await runAgent(conversationId, message, (ev) => emit(ev.event, (ev as any).data));
      } catch (error) {
        emit("error", { message: error instanceof Error ? error.message : String(error) });
      } finally { controller.close(); }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
