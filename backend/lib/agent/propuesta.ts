/**
 * Proponer y confirmar: la confirmación del huésped deja de depender del prompt.
 *
 * Antes el prompt le pedía al modelo mostrar el resumen y esperar la respuesta
 * antes de crear la reserva, pero nada en el código lo exigía: si el modelo se
 * adelantaba, la reserva se creaba con datos que el huésped no había visto (la
 * modalidad de pago, en los mensajes 3 y 37 del Anexo I y en RML-4229).
 *
 * Ahora la creación tiene dos pasos:
 *
 *   1. proponer_reserva valida todo (reglas del hotel, disponibilidad, precio),
 *      NO escribe la reserva y guarda la propuesta junto al teléfono.
 *   2. crear_reserva sólo escribe si existe una propuesta con los MISMOS datos
 *      hecha en un turno ANTERIOR. Como cada turno empieza con un mensaje nuevo
 *      del huésped, eso garantiza que el huésped recibió el resumen y contestó
 *      después de verlo.
 *
 * La propuesta se guarda en ConversationSession.context, una tabla que ya
 * existía en el esquema sin uso: no hace falta migrar.
 */

import { prisma } from "@/lib/prisma";
import type { Channel } from "@prisma/client";

/** Pasado este tiempo la propuesta vence: precios y disponibilidad pueden haber cambiado. */
export const VIGENCIA_PROPUESTA_MS = 2 * 60 * 60 * 1000;

export type Propuesta = {
  roomId: string;
  roomNumber: string;
  guestName: string;
  guestEmail?: string;
  checkIn: string;
  checkOut: string;
  numGuests: number;
  paymentType: "DEPOSIT" | "FULL";
  totalPrice: number;
  payAmount: number;
  /** Momento en que se propuso (ISO). */
  at: string;
};

export type PedidoDeCreacion = {
  roomId: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  numGuests: number;
  paymentType: string;
};

const normalizarNombre = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * ¿Puede crearse la reserva? Función pura, probada en agent:check.
 * Devuelve null si sí, o el motivo (para el modelo) si no.
 */
export function verificarConfirmacion(
  propuesta: Propuesta | null,
  pedido: PedidoDeCreacion,
  inicioTurno: Date,
  ahora: Date
): string | null {
  if (!propuesta) {
    return "Antes de crear la reserva llamá a proponer_reserva, mostrale el resumen al huésped y esperá que lo confirme.";
  }
  const at = new Date(propuesta.at);
  if (ahora.getTime() - at.getTime() > VIGENCIA_PROPUESTA_MS) {
    return "La propuesta venció. Volvé a llamar a proponer_reserva y mostrale el resumen actualizado al huésped.";
  }

  const distintos: string[] = [];
  if (propuesta.roomId !== pedido.roomId) distintos.push("la habitación");
  if (propuesta.checkIn !== pedido.checkIn || propuesta.checkOut !== pedido.checkOut) distintos.push("las fechas");
  if (propuesta.numGuests !== pedido.numGuests) distintos.push("la cantidad de personas");
  if (propuesta.paymentType !== pedido.paymentType) distintos.push("la modalidad de pago");
  if (normalizarNombre(propuesta.guestName) !== normalizarNombre(pedido.guestName)) distintos.push("el nombre");
  if (distintos.length > 0) {
    return (
      `Los datos no coinciden con el resumen que vio el huésped (cambió ${distintos.join(", ")}). ` +
      "Llamá a proponer_reserva con los datos nuevos y esperá que el huésped los confirme."
    );
  }

  // La propuesta se hizo en este mismo turno: el huésped todavía no la vio.
  if (at.getTime() >= inicioTurno.getTime()) {
    return "El huésped todavía no vio el resumen. Mostráselo y esperá su confirmación antes de crear la reserva.";
  }
  return null;
}

async function sesion(phone: string) {
  return prisma.conversationSession.findFirst({
    where: { phone },
    orderBy: { updatedAt: "desc" },
    select: { id: true, context: true },
  });
}

export async function guardarPropuesta(phone: string, channel: Channel, propuesta: Propuesta) {
  const actual = await sesion(phone);
  const context = { ...((actual?.context as object) ?? {}), propuesta };
  if (actual) {
    await prisma.conversationSession.update({ where: { id: actual.id }, data: { context } });
  } else {
    await prisma.conversationSession.create({ data: { phone, channel, context } });
  }
}

export async function leerPropuesta(phone: string): Promise<Propuesta | null> {
  const actual = await sesion(phone);
  const p = (actual?.context as { propuesta?: Propuesta } | null)?.propuesta;
  return p ?? null;
}

export async function borrarPropuesta(phone: string) {
  const actual = await sesion(phone);
  if (!actual) return;
  const { propuesta: _p, ...resto } = (actual.context as Record<string, unknown>) ?? {};
  void _p;
  await prisma.conversationSession.update({ where: { id: actual.id }, data: { context: resto as object } });
}
