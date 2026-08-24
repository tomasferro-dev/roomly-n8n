/**
 * Cron de mantenimiento.
 *
 * Reemplaza al worker de BullMQ que arrancaba en `instrumentation.ts`. Ese
 * worker vivía en el proceso del server: en Vercel las funciones se congelan
 * entre invocaciones, así que no habría procesado nada.
 *
 * Lo llama Vercel Cron cada 15 minutos (ver vercel.json). Barre por fecha en
 * vez de depender de jobs programados, que se pierden si el proceso que los
 * tenía encolados se reinicia.
 */

import { NextRequest, NextResponse } from "next/server";
import { expirePendingPayments } from "@/services/payment.service";
import { limpiarEventosViejos } from "@/lib/dedup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron manda `Authorization: Bearer $CRON_SECRET` en cada llamada.
 * Sin esta verificación, cualquiera puede disparar cancelaciones de reservas
 * desde afuera.
 */
function autorizado(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron] CRON_SECRET no está configurada.");
    return false;
  }
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!autorizado(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inicio = Date.now();
  try {
    const { vencidas, huerfanas } = await expirePendingPayments();
    const eventos = await limpiarEventosViejos();

    const resumen = {
      ok: true,
      reservasVencidas: vencidas,
      reservasHuerfanas: huerfanas,
      eventosPurgados: eventos,
      durationMs: Date.now() - inicio,
    };
    console.log("[cron] barrido completo:", resumen);
    return NextResponse.json(resumen);
  } catch (err) {
    console.error("[cron] falló el barrido:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
