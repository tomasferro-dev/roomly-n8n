import { prisma } from "@/lib/prisma";

/**
 * Precio de una estadía.
 *
 * Antes el cálculo vivía sólo dentro de createPaymentPreference y el total no
 * se guardaba en la reserva: al modificar las fechas, nada lo recalculaba y el
 * link de pago seguía cobrando el monto viejo. Ahora lo usan proponer_reserva,
 * crear_reserva y modificar_reserva con el mismo criterio.
 *
 * Tarifa: el plan de la reserva si tiene uno; si no, el plan más reciente del
 * tipo de habitación (por fecha de inicio de vigencia).
 */

/** Porcentaje de la seña. */
export const SENIA = 0.15;

export function noches(checkIn: string | Date, checkOut: string | Date): number {
  return Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000);
}

/** Lo que se cobra por Mercado Pago según la modalidad elegida. */
export function montoAPagar(total: number, paymentType: "DEPOSIT" | "FULL" | string): number {
  return paymentType === "DEPOSIT" ? Math.round(total * SENIA) : total;
}

export async function precioPorNoche(roomId: string, ratePlanId?: string | null): Promise<number> {
  if (ratePlanId) {
    const plan = await prisma.ratePlan.findUnique({
      where: { id: ratePlanId },
      select: { pricePerNight: true },
    });
    if (plan) return Number(plan.pricePerNight);
  }
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, select: { typeId: true } });
  const plan = await prisma.ratePlan.findFirst({
    where: { typeId: room.typeId },
    orderBy: { validFrom: "desc" },
    select: { pricePerNight: true },
  });
  if (!plan) throw new Error("No hay tarifa configurada para esta habitación.");
  return Number(plan.pricePerNight);
}

export async function precioDeEstadia(
  roomId: string,
  checkIn: string | Date,
  checkOut: string | Date,
  ratePlanId?: string | null
): Promise<{ pricePerNight: number; nights: number; totalPrice: number }> {
  const pricePerNight = await precioPorNoche(roomId, ratePlanId);
  const nights = noches(checkIn, checkOut);
  return { pricePerNight, nights, totalPrice: pricePerNight * nights };
}

/**
 * Qué pasa con la plata cuando cambia el total de una reserva ya pagada.
 * Función pura, probada en agent:check.
 *
 * Con seña, el resto siempre se abona en el hotel, así que sólo cambia ese
 * saldo. Con pago total, la diferencia queda a favor de una de las partes: si
 * el total sube, el huésped abona la diferencia en el hotel; si baja, el hotel
 * gestiona la devolución (el bot no mueve plata).
 */
export function saldoTrasModificacion(
  totalNuevo: number,
  pagado: number,
  paymentType: "DEPOSIT" | "FULL" | string
): { saldoEnHotel: number; aDevolver: number } {
  const diferencia = totalNuevo - pagado;
  if (paymentType === "DEPOSIT") return { saldoEnHotel: Math.max(0, diferencia), aDevolver: Math.max(0, -diferencia) };
  return diferencia >= 0
    ? { saldoEnHotel: diferencia, aDevolver: 0 }
    : { saldoEnHotel: 0, aDevolver: -diferencia };
}
