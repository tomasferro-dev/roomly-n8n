/**
 * Las seis herramientas del agente.
 *
 * Cinco son el equivalente de los nodos `toolHttpRequest` del workflow de n8n
 * (consultar_habitaciones, crear_reserva, consultar_reserva, modificar_reserva,
 * cancelar_reserva). La sexta, proponer_reserva (iteración 10), separa la
 * propuesta de la creación: ver propuesta.ts. Respecto de n8n hay dos
 * diferencias más:
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
  hoyEnZona,
  ReglaDeReservaError,
  reglasDeHabitacion,
  violacionDeReglas,
} from "@/services/reservation.service";
import { isRoomAvailable } from "@/services/availability.service";
import { createPaymentPreference, reconciliarPago, rehacerPreferencia } from "@/services/payment.service";
import { precioDeEstadia, montoAPagar, saldoTrasModificacion } from "@/services/pricing.service";
import { guardarPropuesta, leerPropuesta, borrarPropuesta, verificarConfirmacion } from "./propuesta";
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
    name: "proponer_reserva",
    description:
      "Valida una reserva (capacidad, estadía mínima, disponibilidad) y calcula el precio, SIN crearla. Llamarla cuando ya tenés todos los datos y la modalidad de pago. Devuelve un resumen que tenés que mostrarle al huésped para que lo confirme.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        roomId: {
          type: Type.STRING,
          description: "ID de la habitación (campo id de consultar_habitaciones)",
        },
        guestName: { type: Type.STRING, description: "Nombre completo del huésped" },
        guestEmail: {
          type: Type.STRING,
          description:
            "Email del huésped, para mandarle la confirmación con el QR. OPCIONAL: omitir si no lo quiso dar.",
        },
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
    name: "crear_reserva",
    description:
      "Crea la reserva que el huésped YA CONFIRMÓ, con link de pago de Mercado Pago. Sólo funciona con los mismos datos de un proponer_reserva cuyo resumen el huésped vio y aceptó en un mensaje posterior. Devuelve code, paymentUrl, payAmount, expiresAt, hotelEmail y hotelPhone.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        roomId: {
          type: Type.STRING,
          description: "ID de la habitación (el mismo de proponer_reserva)",
        },
        guestName: { type: Type.STRING, description: "Nombre completo del huésped" },
        guestEmail: {
          type: Type.STRING,
          description: "Email del huésped. OPCIONAL: omitir si no lo quiso dar.",
        },
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
 * Mismo número aunque uno venga con "+" o espacios (el panel permite cargarlo
 * a mano; WhatsApp lo manda sólo con dígitos).
 */
export function mismoTelefono(a: string, b: string): boolean {
  const digitos = (s: string) => s.replace(/\D/g, "");
  return digitos(a) !== "" && digitos(a) === digitos(b);
}

/** Respuesta única para "no existe" y "no es tuya": no confirma códigos ajenos. */
const RESERVA_NO_ENCONTRADA = (code?: string) => ({
  error: code
    ? `No existe ninguna reserva con el código ${code} para este número.`
    : "No existe ninguna reserva con ese id para este número.",
});

/**
 * Control de titularidad: sólo el teléfono que hizo la reserva puede
 * consultarla, modificarla o cancelarla por WhatsApp.
 *
 * El código RML tiene cuatro dígitos y el huésped lo comparte (capturas,
 * reenvíos), así que no alcanza como prueba de que quien escribe es el
 * titular. El teléfono sí: viene del webhook, no del modelo. Se compara acá y
 * no en el prompt para que valga aunque el modelo reciba un id o un código
 * ajeno.
 */
async function reservaDelTitular(id: string, ctx: AgentContext) {
  const reserva = await prisma.reservation.findUnique({
    where: { id },
    select: { id: true, hotelId: true, guest: { select: { phone: true } } },
  });
  if (!reserva || reserva.hotelId !== ctx.hotelId) return null;
  if (!mismoTelefono(reserva.guest.phone, ctx.phone)) return null;
  return reserva;
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
    numGuests: reserva.numGuests,
    yaExistia: true,
  };
}

/**
 * Qué cambió entre la reserva pendiente y el pedido repetido.
 *
 * La idempotencia reconoce la reserva por teléfono, habitación y fechas, porque
 * el modelo a veces la crea antes de que el huésped elija la modalidad de pago.
 * Si en el pedido nuevo cambiaron la modalidad o la cantidad de personas,
 * devolver la reserva existente cobraría otro monto del que el huésped eligió,
 * así que se avisa en lugar de devolverla.
 */
export function cambiosRespectoDePendiente(
  existente: { code: string; paymentType: string; numGuests: number },
  pedido: { paymentType: string; numGuests: number }
): string | null {
  const modalidad = (t: string) => (t === "FULL" ? "pago total" : "seña del 15 %");
  const cambios: string[] = [];
  if (existente.paymentType !== pedido.paymentType) {
    cambios.push(`la modalidad de pago (era ${modalidad(existente.paymentType)})`);
  }
  if (existente.numGuests !== pedido.numGuests) {
    cambios.push(`la cantidad de personas (eran ${existente.numGuests})`);
  }
  if (cambios.length === 0) return null;
  return (
    `Ya existe la reserva ${existente.code}, pendiente de pago, para la misma habitación y fechas, ` +
    `pero cambió ${cambios.join(" y ")}. Para aplicar el cambio, cancelá esa reserva con ` +
    `cancelar_reserva y proponé una nueva con proponer_reserva con los datos que eligió el huésped.`
  );
}

/**
 * Máximo de reservas impagas y vigentes que puede tener un mismo teléfono.
 * Evita que un solo número bloquee el inventario con reservas que no paga.
 */
export const MAX_PENDIENTES_POR_TELEFONO = 2;

/**
 * Reservas PENDING_PAYMENT del teléfono que todavía bloquean una habitación:
 * con pago pendiente sin vencer, o sin fila de Payment (recién creadas o
 * huérfanas que el barrido todavía no limpió).
 */
async function contarPendientesVigentes(phone: string, hotelId: string): Promise<number> {
  return prisma.reservation.count({
    where: {
      hotelId,
      status: "PENDING_PAYMENT",
      guest: { phone },
      OR: [
        { payment: null },
        { payment: { status: "PENDING", expiresAt: { gt: new Date() } } },
      ],
    },
  });
}

/**
 * Datos de una reserva nueva tal como los manda el modelo, ya normalizados.
 * Comparten formato proponer_reserva y crear_reserva, para que la propuesta y
 * la creación se puedan comparar campo por campo.
 */
async function leerDatosDeReserva(args: Record<string, unknown>, ctx: AgentContext) {
  const roomIdRaw = str(args.roomId);
  const guestName = str(args.guestName);
  const checkIn = str(args.checkIn);
  const checkOut = str(args.checkOut);
  const paymentTypeRaw = str(args.paymentType);

  if (!roomIdRaw || !guestName || !checkIn || !checkOut) {
    return { error: "Faltan datos: roomId, guestName, checkIn y checkOut son obligatorios." } as const;
  }
  const paymentType: "DEPOSIT" | "FULL" | undefined =
    paymentTypeRaw === "DEPOSIT" || paymentTypeRaw === "FULL" ? paymentTypeRaw : undefined;
  if (!paymentType) {
    return { error: "paymentType debe ser 'DEPOSIT' (seña 15%) o 'FULL' (pago total)." } as const;
  }
  const numGuests = Number(args.numGuests ?? 1);
  if (!Number.isInteger(numGuests) || numGuests < 1) {
    return { error: "numGuests debe ser un número entero mayor que cero." } as const;
  }

  // El email es opcional y secundario. Si el modelo manda algo que no parece
  // un email, se descarta en silencio en vez de hacer fallar la reserva: el
  // huésped puede corregirlo después y el canal principal sigue siendo
  // WhatsApp.
  const emailRaw = str(args.guestEmail);
  const guestEmail = emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailRaw)
    ? emailRaw.toLowerCase()
    : undefined;

  return {
    roomId: await resolveRoomId(roomIdRaw, ctx.hotelId),
    guestName,
    guestEmail,
    checkIn,
    checkOut,
    numGuests,
    paymentType,
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

    // crear_reserva ya rechaza un ingreso pasado, pero si la consulta lo
    // aceptaba el modelo le confirmaba disponibilidad al huésped y recién
    // fallaba al reservar. Se corta acá con el mismo criterio de fecha.
    const hoy = hoyEnZona(ctx.timezone);
    if (checkIn < hoy) {
      return { error: `La fecha de ingreso (${checkIn}) ya pasó: hoy es ${hoy}. Pedile al huésped una fecha desde hoy.` };
    }

    const rooms = await getAvailableRooms(ctx.hotelId, checkIn, checkOut);
    if (rooms.length === 0) {
      return { rooms: [], mensaje: "No hay habitaciones disponibles para esas fechas." };
    }
    return { rooms };
  },

  async proponer_reserva(args, ctx) {
    const datos = await leerDatosDeReserva(args, ctx);
    if ("error" in datos) return datos;
    const { roomId, guestName, guestEmail, checkIn, checkOut, numGuests, paymentType } = datos;

    const room = await prisma.room.findFirst({
      where: { id: roomId, hotelId: ctx.hotelId },
      select: { number: true },
    });
    if (!room) return { error: "Esa habitación no existe. Usá el id que devuelve consultar_habitaciones." };

    // Las mismas reglas que aplica createReservation, para no proponerle al
    // huésped algo que después no se va a poder crear.
    const reglas = await reglasDeHabitacion(roomId);
    const violacion = violacionDeReglas({ checkIn, checkOut, numGuests, ...reglas, validarIngreso: true });
    if (violacion) return { error: violacion };
    if (!(await isRoomAvailable(roomId, checkIn, checkOut))) {
      return { error: "La habitación ya no está disponible para esas fechas." };
    }
    const pendientes = await contarPendientesVigentes(ctx.phone, ctx.hotelId);
    if (pendientes >= MAX_PENDIENTES_POR_TELEFONO) {
      return {
        error:
          `El huésped ya tiene ${pendientes} reservas pendientes de pago. ` +
          "Antes de proponer otra tiene que pagar o cancelar alguna de las que ya tiene.",
      };
    }

    const { pricePerNight, nights, totalPrice } = await precioDeEstadia(roomId, checkIn, checkOut);
    const payAmount = montoAPagar(totalPrice, paymentType);

    await guardarPropuesta(ctx.phone, ctx.channel, {
      roomId, roomNumber: room.number, guestName, guestEmail, checkIn, checkOut, numGuests,
      paymentType, totalPrice, payAmount, at: new Date().toISOString(),
    });

    return {
      propuesta: {
        room: room.number,
        guestName,
        guestEmail: guestEmail ?? null,
        checkIn,
        checkOut,
        nights,
        numGuests,
        pricePerNight,
        totalPrice,
        paymentType,
        payAmount,
      },
      siguientePaso:
        "Mostrale este resumen al huésped y preguntale si lo confirma. NO llames a crear_reserva en este mismo turno: " +
        "esperá su respuesta y, si confirma, llamá a crear_reserva con exactamente estos datos.",
    };
  },

  async crear_reserva(args, ctx) {
    const datos = await leerDatosDeReserva(args, ctx);
    if ("error" in datos) return datos;
    const { roomId, guestName, checkIn, checkOut, numGuests, paymentType } = datos;
    let { guestEmail } = datos;

    // Idempotencia. El modelo a veces llama a esta herramienta dos veces con
    // los mismos datos: se adelanta y crea la reserva antes de que el huésped
    // elija seña o total, y cuando el huésped responde vuelve a llamarla. La
    // segunda choca contra la primera ("no disponible") y deja una reserva
    // huérfana en PENDING_PAYMENT bloqueando la habitación hasta que expire.
    //
    // Un pedido repetido con los mismos datos es la MISMA reserva, no otra:
    // devolvemos la que ya existe con su link de pago original.
    const existente = await buscarReservaPendiente(ctx.phone, roomId, checkIn, checkOut);
    if (existente) {
      const cambio = cambiosRespectoDePendiente(existente, { paymentType, numGuests });
      return cambio ? { error: cambio } : existente;
    }

    // Confirmación del huésped: tiene que existir una propuesta con estos
    // mismos datos, mostrada en un turno anterior (ver propuesta.ts).
    const propuesta = await leerPropuesta(ctx.phone);
    const sinConfirmar = verificarConfirmacion(
      propuesta,
      { roomId, guestName, checkIn, checkOut, numGuests, paymentType },
      ctx.inicioTurno ?? new Date(),
      new Date()
    );
    if (sinConfirmar) return { error: sinConfirmar };
    guestEmail = guestEmail ?? propuesta?.guestEmail;

    // Límite de reservas impagas por teléfono. Cada PENDING_PAYMENT bloquea una
    // habitación hasta 24 h; sin tope, un mismo número (o un loop del modelo)
    // podría dejar al hotel sin inventario sin pagar nada. Va DESPUÉS de la
    // idempotencia: repetir la misma reserva no cuenta como una nueva.
    const pendientes = await contarPendientesVigentes(ctx.phone, ctx.hotelId);
    if (pendientes >= MAX_PENDIENTES_POR_TELEFONO) {
      console.warn(`[agent:tool:crear_reserva] límite de ${MAX_PENDIENTES_POR_TELEFONO} reservas pendientes alcanzado`);
      return {
        error:
          `El huésped ya tiene ${pendientes} reservas pendientes de pago. ` +
          "Antes de crear otra tiene que pagar o cancelar alguna de las que ya tiene.",
      };
    }

    const parsed = CreateReservationSchema.safeParse({
      hotelId: ctx.hotelId,
      roomId,
      guestName,
      guestEmail,
      // Forzado desde el webhook: el modelo no elige a nombre de qué número reserva.
      guestPhone: ctx.phone,
      checkIn,
      checkOut,
      numGuests,
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
    await borrarPropuesta(ctx.phone);
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

  async consultar_reserva(args, ctx) {
    const code = str(args.code)?.toUpperCase();
    if (!code) return { error: "Falta el código RML." };

    let reservation = await findReservationByCode(code);
    if (
      !reservation ||
      reservation.hotelId !== ctx.hotelId ||
      !mismoTelefono(reservation.guest.phone, ctx.phone)
    ) {
      return RESERVA_NO_ENCONTRADA(code);
    }

    // Si sigue esperando el pago, se le pregunta a Mercado Pago en el momento
    // en vez de depender de que su aviso haya llegado. Es el caso típico de
    // "ya pagué": el huésped pagó, el aviso se demoró o se perdió, y sin esto
    // el bot le contestaría que todavía no ve el pago.
    if (reservation.status === "PENDING_PAYMENT") {
      const resultado = await reconciliarPago(reservation.id);
      if (resultado === "CONFIRMADA" || resultado === "EN_CURSO") {
        reservation = (await findReservationByCode(code)) ?? reservation;
      }
    }

    return {
      id: reservation.id,
      code: reservation.code,
      status: reservation.status,
      guestName: reservation.guestName ?? reservation.guest.name,
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

  async modificar_reserva(args, ctx) {
    const id = str(args.id);
    if (!id) return { error: "Falta el id interno de la reserva." };
    if (!(await reservaDelTitular(id, ctx))) return RESERVA_NO_ENCONTRADA();

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

    const antes = await prisma.reservation.findUniqueOrThrow({
      where: { id },
      select: { totalPrice: true },
    });
    const updated = await updateReservation(id, parsed.data, PERFORMED_BY);
    const respuesta: Record<string, unknown> = {
      id: updated.id,
      code: updated.code,
      status: updated.status,
      room: updated.room.number,
      checkIn: updated.checkIn.toISOString().slice(0, 10),
      checkOut: updated.checkOut.toISOString().slice(0, 10),
      numGuests: updated.numGuests,
      totalPrice: updated.totalPrice ? Number(updated.totalPrice) : null,
    };

    // Si cambió el total, la plata tiene que acompañar el cambio (A-19).
    const cambioElTotal =
      updated.totalPrice !== null && Number(updated.totalPrice) !== Number(antes.totalPrice ?? NaN);
    if (!cambioElTotal) return respuesta;

    const pago = await prisma.payment.findUnique({ where: { reservationId: id } });
    if (updated.status === "PENDING_PAYMENT") {
      // Impaga: el link anterior cobraría el monto viejo; se rehace.
      const nuevo = await rehacerPreferencia(id);
      if (nuevo) {
        return {
          ...respuesta,
          paymentUrl: nuevo.paymentUrl,
          payAmount: nuevo.payAmount,
          expiresAt: nuevo.expiresAt,
          aviso: "Cambió el total: mandale al huésped el link de pago nuevo; el anterior ya no sirve.",
        };
      }
    } else if (pago?.status === "APPROVED") {
      const saldo = saldoTrasModificacion(Number(updated.totalPrice), Number(pago.amount), pago.paymentType);
      return {
        ...respuesta,
        pagado: Number(pago.amount),
        ...saldo,
        aviso:
          saldo.aDevolver > 0
            ? "El total bajó por debajo de lo pagado: decile al huésped que el hotel lo va a contactar por la devolución."
            : "Informale al huésped el nuevo total y el saldo que abona en el hotel.",
      };
    }
    return respuesta;
  },

  async cancelar_reserva(args, ctx) {
    const id = str(args.id);
    if (!id) return { error: "Falta el id interno de la reserva." };
    if (!(await reservaDelTitular(id, ctx))) return RESERVA_NO_ENCONTRADA();

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

    // Las reglas del hotel ya vienen en castellano y sin detalles internos.
    if (err instanceof ReglaDeReservaError) {
      return { result: { error: message }, ok: false };
    }

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
