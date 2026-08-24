import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { handleMPWebhook } from "@/services/payment.service";
import { reclamarEvento } from "@/lib/dedup";

/**
 * POST /api/v1/payments/webhook
 * Recibe notificaciones IPN de Mercado Pago.
 *
 * MP exige una respuesta 200 inmediata, así que el procesamiento real va
 * después de responder.
 *
 * IMPORTANTE — por qué `after()` y no un fire-and-forget suelto:
 * antes esto llamaba a `handleMPWebhook()` sin await y devolvía el 200. En un
 * servidor de larga vida funciona. En Vercel la función se congela apenas
 * devolvés la respuesta, así que el procesamiento quedaba a la mitad y la
 * reserva NUNCA pasaba a CONFIRMED: el huésped pagaba y no recibía nada.
 * `after()` le dice a la plataforma que mantenga la función viva hasta que el
 * trabajo termine.
 *
 * Ruta EXCLUIDA del middleware de autenticación (ver middleware.ts).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  const topic     = body?.type     ?? req.nextUrl.searchParams.get("topic");
  const paymentId = body?.data?.id ?? req.nextUrl.searchParams.get("id");

  if (topic === "payment" && paymentId) {
    after(async () => {
      // MP reintenta la notificación varias veces por el mismo pago. Procesarla
      // dos veces dispararía dos avisos de WhatsApp al huésped.
      const esNuevo = await reclamarEvento("MERCADOPAGO", String(paymentId));
      if (!esNuevo) {
        console.log(`[pagos:webhook] notificación repetida ${paymentId}, se ignora`);
        return;
      }

      try {
        await handleMPWebhook(String(paymentId));
      } catch (err) {
        console.error("[pagos:webhook] error procesando el pago:", err);
      }
    });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
