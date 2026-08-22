/**
 * Las cinco herramientas del agente.
 *
 * Son el equivalente exacto de los nodos `toolHttpRequest` del workflow de n8n
 * (consultar_habitaciones, crear_reserva, consultar_reserva, modificar_reserva,
 * cancelar_reserva), con dos diferencias:
 *
 *  1. No viajan por HTTP. n8n llamaba a `/api/v1/...` del propio backend con el
 *     secreto compartido en la query string (`&_s=...`), lo que dejaba el
 *     secreto en logs de acceso y en el historial de ejecuciones. Acá se llama
 *     a los services en proceso: sin round-trip y sin secreto.
 *
 *  2. `guestPhone` no lo elige el modelo. El prompt le pide que use el teléfono
 *     del huésped, pero un modelo puede equivocarse y crear la reserva a nombre
 *     de otro número. Acá se fuerza desde el contexto del webhook, que es el
 *     único origen confiable.
 *
 * Los nombres, descripciones y parámetros se mantienen idénticos a los del
 * workflow para que el prompt portado siga funcionando sin cambios.
 */

import { Type, type FunctionDeclaration } from "@google/genai";
import { prisma } from "@/lib/prisma";
import { getAvailableRooms } from "@/services/availability.service";
import {
  createReservation,
  updateReservation,
  cancelReservation,
  findReservationByCode,
} from "@/services/reservation.service";
import { createPaymentPreference } from "@/services/payment.service";
import { CreateReservationSchema, UpdateReservationSchema } from "@/lib/validations";
import type { AgentContext, ToolHandler } from "./types";

/** Quién queda registrado en los AuditLog de las acciones del bot. */
const PERFORMED_BY = "bot";

// ─── Declaraciones para Gemini ────────────────────────────────────────────────

export const functionDeclarations: FunctionDeclaration[] = [
  {
    name: "consultar_habitaciones",
    description:
      "Consulta habitaciones disponibles para un rango de fechas. Devuelve lista con id, número, tipo y capacidad. SIEMPRE llamar antes de crear una reserva.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        checkIn: { type: Type.STRING, description: "Fecha check-in YYYY-MM-DD" },
        checkOut: { type: Type.STRING, description: "Fecha check-out YYYY-MM-DD" },
      },
      required: ["checkIn", "checkOut"],
    },
  },
  {
    name: "crear_reserva",
    description:
      "Crea una nueva reserva con link de pago de Mercado Pago. Requiere roomId, guestName, checkIn, checkOut, numGuests y paymentType. Devuelve code, paymentUrl, payAmount, expiresAt, hotelEmail y hotelPhone.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        roomId: {
          type: Type.STRING,
          description: "ID de la habitación (campo id de consultar_habitaciones)",
        },
        guestName: { type: Type.STRING, description: "Nombre completo del huésped" },
        checkIn: { type: Type.STRING, description: "Fecha check-in YYYY-MM-DD" },
        checkOut: { type: Type.STRING, description: "Fecha check-out YYYY-MM-DD" },
        numGuests: { type: Type.NUMBER, description: "Cantidad de personas (número entero)" },
        paymentType: {
          type: Type.STRING,
          enum: ["DEPOSIT", "FULL"],
          description: "DEPOSIT para seña del 15%, FULL para pago total completo",
        },
      },
      required: ["roomId", "guestName", "checkIn", "checkOut", "numGuests", "paymentType"],
    },
  },
  {
    name: "consultar_reserva",
    description:
      "Busca una reserva por su código RML (ej: RML-1234). Devuelve los detalles incluyendo el 'id' interno necesario para modificar o cancelar.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        code: { type: Type.STRING, description: "Código RML de la reserva, ej: RML-1234" },
      },
      required: ["code"],
    },
  },
  {
    name: "modificar_reserva",
    description:
      "Modifica fechas o cantidad de personas de una reserva. Requiere el 'id' interno (de consultar_reserva). Pasar solo los campos que cambian.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: {
          type: Type.STRING,
          description: "ID interno de la reserva (campo id de consultar_reserva)",
        },
        checkIn: {
          type: Type.STRING,
          description: "Nueva fecha check-in YYYY-MM-DD (omitir si no cambia)",
        },
        checkOut: {
          type: Type.STRING,
          description: "Nueva fecha check-out YYYY-MM-DD (omitir si no cambia)",
        },
        numGuests: {
          type: Type.NUMBER,
          description: "Nueva cantidad de personas (omitir si no cambia)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "cancelar_reserva",
    description:
      "Cancela una reserva (estado CANCELLED). Requiere el 'id' interno (de consultar_reserva). SOLO ejecutar tras confirmación EXPLÍCITA del huésped.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING, description: "ID interno de la reserva a cancelar" },
      },
      required: ["id"],
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/**
 * El modelo a veces devuelve el número de habitación ("101") en lugar del cuid.
 * La ruta `/reservations/crear` ya contemplaba esto; se replica el mismo criterio.
 */
async function resolveRoomId(raw: string, hotelId: string): Promise<string> {
  if (/^c[a-z0-9]{20,}$/.test(raw)) return raw;
  const room = await prisma.room.findUnique({
    where: { hotelId_number: { hotelId, number: raw } },
    select: { id: true },
  });
  return room?.id ?? raw;
}

/**
 * Reserva ya pendiente de pago para el mismo huésped, habitación y fechas.
 *
 * Devuelve el mismo shape que `crear_reserva`, reconstruyendo la URL de
 * checkout desde el id de preferencia (Mercado Pago la arma siempre igual;
 * la URL no se guarda en la tabla Payment). Si el pago ya venció o no está
 * pendiente, devuelve null y se crea una reserva nueva.
 */
async function buscarReservaPendiente(
  phone: string,
  roomId: string,
  checkIn: string,
  checkOut: string
) {
  const reserva = await prisma.reservation.findFirst({
    where: {
      roomId,
      status: "PENDING_PAYMENT",
      checkIn: new Date(checkIn),
      checkOut: new Date(checkOut),
      guest: { phone },
    },
    orderBy: { createdAt: "desc" },
    include: {
      payment: true,
      hotel: { select: { email: true, phone: true } },
    },
  });

  const pago = reserva?.payment;
  if (!reserva || !pago) return null;
  if (pago.status !== "PENDING" || pago.expiresAt <= new Date()) return null;
  if (!pago.mpPreferenceId) return null;

  const nights = Math.round(
    (reserva.checkOut.getTime() - reserva.checkIn.getTime()) / 86400000
  );
  const payAmount = Number(pago.amount);
  const totalPrice =
    pago.paymentType === "DEPOSIT" ? Math.round(payAmount / 0.15) : payAmount;

  return {
    code: reserva.code,
    status: reserva.status,
    paymentUrl: `https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=${pago.mpPreferenceId}`,
    payAmount,
    totalPrice,
    paymentType: pago.paymentType,
    expiresAt: pago.expiresAt,
    hotelEmail: reserva.hotel.email,
    hotelPhone: reserva.hotel.phone,
    nights,
    yaExistia: true,
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

const handlers: Record<string, ToolHandler> = {
  async consultar_habitaciones(args, ctx) {
    const checkIn = str(args.checkIn);
    const checkOut = str(args.checkOut);
    if (!checkIn || !checkOut) {
      return { error: "checkIn y checkOut son obligatorios (formato YYYY-MM-DD)." };
    }
    if (new Date(checkOut) <= new Date(checkIn)) {
      return { error: "checkOut debe ser posterior a checkIn." };
    }

    const rooms = await getAvailableRooms(ctx.hotelId, checkIn, checkOut);
    if (rooms.length === 0) {
      return { rooms: [], mensaje: "No hay habitaciones disponibles para esas fechas." };
    }
    return { rooms };
  },

  async crear_reserva(args, ctx) {
    const roomIdRaw = str(args.roomId);
    const guestName = str(args.guestName);
    const checkIn = str(args.checkIn);
    const checkOut = str(args.checkOut);
    const paymentTypeRaw = str(args.paymentType);

    if (!roomIdRaw || !guestName || !checkIn || !checkOut) {
      return { error: "Faltan datos: roomId, guestName, checkIn y checkOut son obligatorios." };
    }

    const paymentType =
      paymentTypeRaw === "DEPOSIT" || paymentTypeRaw === "FULL" ? paymentTypeRaw : undefined;
    if (!paymentType) {
      return { error: "paymentType debe ser 'DEPOSIT' (seña 15%) o 'FULL' (pago total)." };
    }

    const roomId = await resolveRoomId(roomIdRaw, ctx.hotelId);

    // Idempotencia. El modelo a veces llama a esta herramienta dos veces con
    // los mismos datos: se adelanta y crea la reserva antes de que el huésped
    // elija seña o total, y cuando el huésped responde vuelve a llamarla. La
    // segunda choca contra la primera ("no disponible") y deja una reserva
    // huérfana en PENDING_PAYMENT bloqueando la habitación hasta que expire.
    //
    // Un pedido repetido con los mismos datos es la MISMA reserva, no otra:
    // devolvemos la que ya existe con su link de pago original.
    const existente = await buscarReservaPendiente(ctx.phone, roomId, checkIn, checkOut);
    if (existente) return existente;

    const parsed = CreateReservationSchema.safeParse({
      hotelId: ctx.hotelId,
      roomId,
      guestName,
      // Forzado desde el webhook: el modelo no elige a nombre de qué número reserva.
      guestPhone: ctx.phone,
      checkIn,
      checkOut,
      numGuests: args.numGuests ?? 1,
      channel: ctx.channel,
      paymentType,
    });

    if (!parsed.success) {
      return {
        error: "Datos inválidos para crear la reserva.",
        detalles: parsed.error.flatten().fieldErrors,
      };
    }

    const reservation = await createReservation(parsed.data);
    const payment = await createPaymentPreference(reservation.id, paymentType);

    // Mismo shape que devolvía GET /api/v1/reservations/crear, para que el
    // prompt portado encuentre exactamente los campos que espera.
    return {
      code: reservation.code,
      status: reservation.status,
      paymentUrl: payment.paymentUrl,
      payAmount: payment.payAmount,
      totalPrice: payment.totalPrice,
      paymentType: payment.paymentType,
      expiresAt: payment.expiresAt,
      hotelEmail: payment.hotelEmail,
      hotelPhone: payment.hotelPhone,
    };
  },

  async consultar_reserva(args) {
    const code = str(args.code)?.toUpperCase();
    if (!code) return { error: "Falta el código RML." };

    const reservation = await findReservationByCode(code);
    if (!reservation) {
      return { error: `No existe ninguna reserva con el código ${code}.` };
    }

    return {
      id: reservation.id,
      code: reservation.code,
      status: reservation.status,
      guestName: reservation.guestName ?? reservation.guest.name,
      guestPhone: reservation.guest.phone,
      room: reservation.room.number,
      floor: reservation.room.floor,
      checkIn: reservation.checkIn.toISOString().slice(0, 10),
      checkOut: reservation.checkOut.toISOString().slice(0, 10),
      numGuests: reservation.numGuests,
      pricePerNight: reservation.ratePlan
        ? Number(reservation.ratePlan.pricePerNight)
        : null,
      totalPrice: reservation.totalPrice ? Number(reservation.totalPrice) : null,
    };
  },

  async modificar_reserva(args) {
    const id = str(args.id);
    if (!id) return { error: "Falta el id interno de la reserva." };

    const patch: Record<string, unknown> = {};
    const checkIn = str(args.checkIn);
    const checkOut = str(args.checkOut);
    if (checkIn) patch.checkIn = checkIn;
    if (checkOut) patch.checkOut = checkOut;
    if (args.numGuests !== undefined && args.numGuests !== null) {
      patch.numGuests = args.numGuests;
    }

    if (Object.keys(patch).length === 0) {
      return { error: "No se indicó ningún campo a modificar." };
    }

    const parsed = UpdateReservationSchema.safeParse(patch);
    if (!parsed.success) {
      return {
        error: "Datos inválidos para modificar la reserva.",
        detalles: parsed.error.flatten().fieldErrors,
      };
    }

    const updated = await updateReservation(id, parsed.data, PERFORMED_BY);
    return {
      id: updated.id,
      code: updated.code,
      status: updated.status,
      room: updated.room.number,
      checkIn: updated.checkIn.toISOString().slice(0, 10),
      checkOut: updated.checkOut.toISOString().slice(0, 10),
      numGuests: updated.numGuests,
    };
  },

  async cancelar_reserva(args) {
    const id = str(args.id);
    if (!id) return { error: "Falta el id interno de la reserva." };

    const cancelled = await cancelReservation(id, PERFORMED_BY);
    return { id: cancelled.id, code: cancelled.code, status: cancelled.status };
  },
};

// ─── Ejecución ────────────────────────────────────────────────────────────────

/**
 * Ejecuta una herramienta y devuelve siempre un objeto serializable.
 *
 * Los errores NO se propagan: se devuelven al modelo como `{ error }` para que
 * pueda explicárselo al huésped en castellano. n8n hacía lo mismo — un nodo de
 * herramienta que falla le entrega el error al agente, no corta el flujo.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext
): Promise<{ result: unknown; ok: boolean }> {
  const handler = handlers[name];
  if (!handler) {
    return { result: { error: `Herramienta desconocida: ${name}` }, ok: false };
  }

  try {
    const result = await handler(args, ctx);
    const ok = !(result && typeof result === "object" && "error" in result);
    return { result, ok };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent:tool:${name}]`, err);

    // Traducir los errores conocidos de los services a algo que el modelo
    // pueda transmitir sin filtrar detalles internos.
    if (message.includes("not available")) {
      return {
        result: { error: "La habitación ya no está disponible para esas fechas." },
        ok: false,
      };
    }
    if (message.includes("already")) {
      return { result: { error: "La reserva ya estaba cancelada o finalizada." }, ok: false };
    }
    if (message.includes("No hay tarifa configurada")) {
      return {
        result: { error: "Esa habitación no tiene tarifa cargada. Avisale al hotel." },
        ok: false,
      };
    }

    return { result: { error: "No se pudo completar la operación." }, ok: false };
  }
}
