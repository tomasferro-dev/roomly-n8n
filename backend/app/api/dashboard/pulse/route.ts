/**
 * GET /api/dashboard/pulse
 *
 * Devuelve una huella barata del estado de las reservas. El dashboard la
 * consulta cada pocos segundos y sólo se refresca cuando cambia.
 *
 * Reemplaza al endpoint SSE `/api/dashboard/events`, que mantenía una conexión
 * abierta suscrita a Redis. En Vercel ese stream se corta al llegar al
 * `maxDuration` de la función, así que el dashboard se quedaba mudo sin avisar.
 *
 * Es más barato de lo que parece: dos agregados sobre una tabla indexada, sin
 * traer filas. El cliente compara la huella y sólo pide un refresh completo
 * cuando algo cambió de verdad.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [agg, total] = await Promise.all([
      prisma.reservation.aggregate({ _max: { updatedAt: true } }),
      prisma.reservation.count(),
    ]);

    // El count entra en la huella porque una reserva nueva puede compartir el
    // updatedAt con otra que se acaba de modificar en el mismo tick.
    const v = `${agg._max.updatedAt?.getTime() ?? 0}-${total}`;

    return NextResponse.json(
      { v },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[GET /dashboard/pulse]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
