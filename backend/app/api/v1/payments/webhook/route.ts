import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { handleMPWebhook } from "@/services/payment.service";
import { reclamarEvento } from "@/lib/dedup";
import { verifyMercadoPagoSignature } from "@/lib/signatures";

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

  // Firma de Mercado Pago. Se valida SOLO si la notificación trae
  // `x-signature`: la documentación no garantiza que las notificaciones del
  // `notification_url` de la preferencia ni las IPN (`topic`/`id`) vengan
  // firmadas, y rechazarlas dejaría pagos cobrados sin confirmar. Lo que sí
  // protege siempre es que handleMPWebhook consulta el pago contra la API de
  // MP antes de confirmar nada; la firma corta antes las falsificaciones.
  const mpSecret  = process.env.MP_WEBHOOK_SECRET;
  const signature = req.headers.get("x-signature");
  if (mpSecret && signature) {
    const valida = verifyMercadoPagoSignature({
      header:    signature,
      requestId: req.headers.get("x-request-id"),
      dataId:    req.nextUrl.searchParams.get("data.id") ?? (body?.data?.id != null ? String(body.data.id) : null),
      secret:    mpSecret,
    });
    if (!valida) {
      console.warn("[pagos:webhook] x-signature inválida; se rechaza la notificación");
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  }

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
