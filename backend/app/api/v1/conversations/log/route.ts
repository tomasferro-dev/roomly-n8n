import { NextRequest, NextResponse } from "next/server";
import { LogMessageSchema } from "@/lib/validations";
import { logInteraction } from "@/services/conversation.service";

/**
 * POST /api/v1/conversations/log
 * Persiste un turno de la conversación de WhatsApp (mensaje del usuario y/o
 * respuesta del bot). Lo llama el nodo "Logging" de n8n tras responder.
 * Protegido por el middleware: sesión del panel o header `x-n8n-secret`.
 *
 * Body JSON: { phone, userMessage?, botMessage?, channel?, waTimestamp?, hotelId? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = LogMessageSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation error", details: parsed.error.flatten() },
        { status: 422 }
      );
    }

    const result = await logInteraction(parsed.data);
    return NextResponse.json({ ok: true, stored: result.count }, { status: 201 });
  } catch (err) {
    console.error("[POST /conversations/log]", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
