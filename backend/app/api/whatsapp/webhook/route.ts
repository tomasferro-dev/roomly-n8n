/**
 * Webhook de WhatsApp.
 *
 * Reemplaza a los dos nodos webhook del workflow de n8n ("Verificación Meta" y
 * "WhatsApp Mensajes"), que compartían el path `/webhook/roomly-wa`.
 *
 * Esta ruta NO pasa por el middleware de autenticación: su matcher cubre
 * `/dashboard/*` y `/api/v1/*`, y esto vive en `/api/whatsapp/*`. Meta no envía
 * credenciales; la verificación es por el token compartido en el GET.
 */

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import {
  extraerMensaje,
  enviarTexto,
  enviarDisculpa,
  type MensajeEntrante,
} from "@/lib/channels/whatsapp";
import { reclamarEvento } from "@/lib/dedup";
import { runAgent } from "@/lib/agent/run";
import { saveRun } from "@/lib/agent/trace";
import { resolveHotelId, loadBotConfig } from "@/lib/agent/config";
import { logInteraction } from "@/services/conversation.service";
import type { AgentContext } from "@/lib/agent/types";

// Prisma y el SDK de Gemini necesitan el runtime de Node, no el de Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tope de ejecución de la función. El agente puede encadenar dos o tres
 * llamadas a herramientas más los turnos del modelo; con reintentos por rate
 * limit eso llega a superar el default de 10 s del plan Hobby. El trabajo
 * corre en `after()`, o sea DESPUÉS de haber respondido el 200, así que este
 * tope protege al procesamiento, no al ack.
 */
export const maxDuration = 60;

// ─── GET: verificación del webhook ────────────────────────────────────────────

/**
 * Meta llama a este endpoint una vez, al configurar el webhook en el panel de
 * desarrolladores. Hay que devolver el `hub.challenge` tal cual, en texto
 * plano, sólo si el token coincide.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  const esperado = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!esperado) {
    console.error("[whatsapp:webhook] WHATSAPP_VERIFY_TOKEN no está configurada.");
    return new NextResponse("Server misconfigured", { status: 500 });
  }

  if (mode === "subscribe" && token === esperado && challenge) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new NextResponse("Forbidden", { status: 403 });
}

// ─── POST: mensajes entrantes ─────────────────────────────────────────────────

/**
 * Meta espera un 200 en menos de ~20 segundos; si no, reintenta y termina
 * dando el mensaje por fallido. El agente tarda bastante más que eso, así que
 * se responde de inmediato y el trabajo real se hace en `after()`.
 *
 * Es el mismo patrón del nodo "Ack 200" del workflow, que respondía antes de
 * que corriera el agente.
 */
export async function POST(req: NextRequest) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const mensaje = extraerMensaje(payload);

  // Sin mensaje de texto no hay nada que hacer: Meta manda por acá también los
  // avisos de entrega y lectura, y los mensajes que no son texto.
  if (!mensaje) {
    return NextResponse.json({ ok: true, skipped: true }, { status: 200 });
  }

  after(async () => {
    try {
      await procesarMensaje(mensaje);
    } catch (err) {
      console.error("[whatsapp:webhook] fallo procesando el mensaje:", err);
      await enviarDisculpa(mensaje.phoneNumberId, mensaje.from);
    }
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}

// ─── Procesamiento ────────────────────────────────────────────────────────────

async function procesarMensaje(mensaje: MensajeEntrante): Promise<void> {
  // Reintento de Meta: ya lo contestamos, no lo contestemos de nuevo.
  const esNuevo = await reclamarEvento("WHATSAPP", mensaje.messageId);
  if (!esNuevo) {
    console.log(`[whatsapp:webhook] mensaje repetido ${mensaje.messageId}, se ignora`);
    return;
  }

  const hotelId = await resolveHotelId();
  if (!hotelId) {
    console.error("[whatsapp:webhook] no hay ningún hotel configurado.");
    await enviarDisculpa(mensaje.phoneNumberId, mensaje.from);
    return;
  }

  const config = await loadBotConfig(hotelId);
  const ctx: AgentContext = {
    hotelId,
    phone: mensaje.from,
    channel: "WHATSAPP",
    timezone: config.timezone,
  };

  const resultado = await runAgent(mensaje.text, ctx);

  // La traza se guarda pase lo que pase — sobre todo si falló, que es cuando
  // hace falta para entender qué pasó.
  await saveRun(ctx, mensaje.text, resultado);

  if (!resultado.text) {
    // Equivale a la rama NO del nodo IF "¿Hay respuesta?", que mandaba el
    // mensaje de disculpa.
    console.warn(
      `[whatsapp:webhook] el agente no produjo respuesta (${resultado.status})`,
      resultado.error ?? ""
    );
    await enviarDisculpa(mensaje.phoneNumberId, mensaje.from);
    return;
  }

  await enviarTexto(mensaje.phoneNumberId, mensaje.from, resultado.text);

  // Persistir el turno DESPUÉS de responder, igual que el nodo "Logging de
  // interacción". El orden importa: es lo que lee la memoria del agente en el
  // próximo mensaje, así que si se guardara antes, el mensaje actual entraría
  // duplicado en el contexto.
  await logInteraction({
    phone: mensaje.from,
    userMessage: mensaje.text,
    botMessage: resultado.text,
    channel: "WHATSAPP",
    waTimestamp: mensaje.timestamp,
    hotelId,
  });
}
