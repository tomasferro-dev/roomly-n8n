import { prisma } from "@/lib/prisma";
import { isRoomAvailable } from "./availability.service";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "@/lib/calendar";
import type { CreateReservationInput, UpdateReservationInput } from "@/lib/validations";

/**
 * Crea la tarea de limpieza posterior al check-out.
 *
 * Antes era el job `SCHEDULE_HOUSEKEEPING` de BullMQ, pero encolarlo no tenía
 * sentido: es un solo INSERT que tarda milisegundos. La cola sólo agregaba una
 * dependencia de Redis y un lugar más donde las cosas se pueden perder.
 *
 * No lanza: una reserva no puede fallar porque no se pudo agendar la limpieza.
 */
export async function scheduleHousekeeping(reservationId: string): Promise<void> {
  try {
    const res = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { id: true, code: true, roomId: true, checkOut: true },
    });
    if (!res) return;

    await prisma.housekeepingTask.create({
      data: {
        roomId: res.roomId,
        reservationId: res.id,
        scheduledFor: res.checkOut,
        status: "PENDING",
        notes: `Post-checkout – ${res.code}`,
      },
    });
  } catch (err) {
    console.warn("[housekeeping] no se pudo agendar la limpieza:", err);
  }
}

// ─── Reglas del dominio ────────────────────────────────────────────────────────

/**
 * Una reserva que viola una regla del hotel. Se distingue de los errores
 * internos para que la API responda 422 y el agente pueda explicarle al
 * huésped qué cambiar.
 */
export class ReglaDeReservaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReglaDeReservaError";
  }
}

/** Fecha de hoy (YYYY-MM-DD) en la zona horaria del hotel, no en UTC. */
export function hoyEnZona(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Capacidad, estadía mínima y fecha de ingreso no pasada.
 *
 * Antes dependían de que el modelo leyera la capacidad en consultar_habitaciones
 * y calculara bien las fechas relativas; son exactamente el tipo de error que
 * el modelo puede cometer, así que se verifican acá, igual que la
 * disponibilidad. Es una función pura para poder probarla sin base.
 *
 * `validarIngreso` es false cuando se modifica una reserva sin cambiar su
 * ingreso: un huésped ya alojado tiene que poder extender su salida.
 */
export function violacionDeReglas(r: {
  checkIn: string;
  checkOut: string;
  numGuests: number;
  maxGuests: number;
  minNights: number;
  hoy: string;
  validarIngreso: boolean;
}): string | null {
  if (r.numGuests > r.maxGuests) {
    return `La habitación admite hasta ${r.maxGuests} personas y la reserva es para ${r.numGuests}.`;
  }
  const noches = Math.round(
    (new Date(r.checkOut).getTime() - new Date(r.checkIn).getTime()) / 86400000
  );
  if (noches < r.minNights) {
    return `La estadía mínima para esta habitación es de ${r.minNights} noches.`;
  }
  if (r.validarIngreso && r.checkIn < r.hoy) {
    return `La fecha de ingreso (${r.checkIn}) ya pasó: hoy es ${r.hoy}.`;
  }
  return null;
}

/**
 * Datos de la habitación que necesitan las reglas. La estadía mínima sale del
 * plan de tarifa de la reserva o, si no tiene, del plan vigente del tipo: el
 * mismo criterio con que se calcula el precio en payment.service.
 */
async function reglasDeHabitacion(roomId: string, ratePlanId?: string | null) {
  const room = await prisma.room.findUniqueOrThrow({
    where: { id: roomId },
    select: {
      typeId: true,
      type: { select: { maxGuests: true } },
      hotel: { select: { timezone: true } },
    },
  });
  const plan = ratePlanId
    ? await prisma.ratePlan.findUnique({ where: { id: ratePlanId }, select: { minNights: true } })
    : await prisma.ratePlan.findFirst({
        where: { typeId: room.typeId },
        orderBy: { validFrom: "desc" },
        select: { minNights: true },
      });
  return {
    maxGuests: room.type.maxGuests,
    minNights: plan?.minNights ?? 1,
    hoy: hoyEnZona(room.hotel.timezone),
  };
}

// ─── Code generator ────────────────────────────────────────────────────────────

function generateRmlCode(): string {
  const num = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `RML-${num}`;
}

async function uniqueCode(): Promise<string> {
  let code: string;
  let exists: boolean;
  do {
    code = generateRmlCode();
    const existing = await prisma.reservation.findUnique({
      where: { code },
      select: { id: true },
    });
    exists = existing !== null;
  } while (exists);
  return code;
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createReservation(input: CreateReservationInput) {
  const { hotelId, roomId, checkIn, checkOut, numGuests, channel, ratePlanId, notes, paymentType } = input;

  // Normalize guest data: accept either nested object (dashboard) or flat fields (n8n)
  const guest = input.guest ?? {
    name: input.guestName!,
    phone: input.guestPhone!,
    email: input.guestEmail,
  };

  // 0. Reglas del hotel: capacidad, estadía mínima e ingreso no pasado.
  const reglas = await reglasDeHabitacion(roomId, ratePlanId);
  const violacion = violacionDeReglas({ checkIn, checkOut, numGuests, ...reglas, validarIngreso: true });
  if (violacion) throw new ReglaDeReservaError(violacion);

  // 1. Check availability (application-level guard; DB constraint is the final safety net)
  const available = await isRoomAvailable(roomId, checkIn, checkOut);
  if (!available) {
    throw new Error(`Room is not available from ${checkIn} to ${checkOut}`);
  }

  // 2. Use provided code or generate a unique one
  const code = input.code ?? (await uniqueCode());

  // 3. Upsert guest (find by hotel + phone, create if new)
  // IMPORTANTE: no se actualiza el nombre en el update para no pisar el nombre
  // registrado en reservas anteriores del mismo huésped. Email y DNI sí se
  // actualizan porque son datos que el huésped puede corregir sin afectar el
  // historial (no aparecen en la vista de reservas pasadas).
  const upsertGuest = () =>
    prisma.guest.upsert({
      where: { hotelId_phone: { hotelId, phone: guest.phone } },
      update: { email: guest.email ?? undefined, dni: guest.dni ?? undefined },
      create: {
        hotelId,
        name: guest.name,
        phone: guest.phone,
        email: guest.email,
        dni: guest.dni,
      },
    });

  // Dos altas simultáneas del mismo huésped nuevo pueden ver las dos que no
  // existe e intentar crearlo: la segunda choca con la unicidad (hotel,
  // teléfono) y devuelve P2002. Para entonces el huésped ya existe, así que
  // repetir el upsert una vez lo resuelve como actualización. Sin esto, esa
  // llamada fallaba con un error genérico en lugar de seguir hasta la
  // verificación de disponibilidad (encontrado en la prueba de concurrencia
  // del 26/10/2026).
  const guestRecord = await upsertGuest().catch((err: unknown) => {
    if ((err as { code?: string })?.code === "P2002") return upsertGuest();
    throw err;
  });

  // 4. Create reservation inside a transaction
  const reservation = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.create({
      data: {
        hotelId,
        roomId,
        guestId: guestRecord.id,
        guestName: guest.name,
        ratePlanId,
        code,
        // Si viene con paymentType es un flujo WhatsApp con pago → queda PENDING_PAYMENT
        // hasta que MP confirme. Si no, el admin crea directo como CONFIRMED.
        status: paymentType ? "PENDING_PAYMENT" : "CONFIRMED",
        channel,
        checkIn: new Date(checkIn),
        checkOut: new Date(checkOut),
        numGuests,
        notes,
      },
      include: {
        room: { select: { number: true } },
        guest: { select: { name: true, phone: true } },
      },
    });

    await tx.auditLog.create({
      data: {
        reservationId: res.id,
        action: "CREATED",
        after: res as object,
        // Ya no es n8n quien crea las reservas por WhatsApp, sino el agente
        // propio. Las filas anteriores conservan "n8n", que sigue siendo cierto
        // para el momento en que se crearon.
        performedBy: channel === "WHATSAPP" ? "bot" : "admin",
      },
    });

    return res;
  });

  // 5. Agendar la limpieza — solo si la reserva ya está CONFIRMED. Si es
  // PENDING_PAYMENT, se agenda cuando MP confirme el pago.
  //
  // El job SEND_CONFIRMATION que existía acá se eliminó: nunca estuvo
  // implementado (era un console.log con un TODO). La confirmación real al
  // huésped la manda el agente por WhatsApp al crear la reserva.
  if (!paymentType) {
    await scheduleHousekeeping(reservation.id);
  }

  // 6. Create Google Calendar event (fire-and-forget; failure does NOT abort the reservation)
  const calendarEventId = await createCalendarEvent({
    code:       reservation.code,
    guestName:  reservation.guestName ?? reservation.guest.name,
    roomNumber: reservation.room.number,
    checkIn:    reservation.checkIn,
    checkOut:   reservation.checkOut,
    numGuests:  reservation.numGuests,
  });

  if (calendarEventId) {
    await prisma.reservation.update({
      where: { id: reservation.id },
      data:  { calendarEventId },
    });
  }

  return reservation;
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateReservation(
  id: string,
  input: UpdateReservationInput,
  performedBy = "admin"
) {
  const current = await prisma.reservation.findUniqueOrThrow({
    where: { id },
  });

  const newRoomId = input.roomId ?? current.roomId;
  const currentCheckIn = current.checkIn.toISOString().split("T")[0];
  const newCheckIn = input.checkIn ?? currentCheckIn;
  const newCheckOut = input.checkOut ?? current.checkOut.toISOString().split("T")[0];

  // Reglas del hotel sobre el resultado del cambio, no sólo sobre los campos
  // nuevos: bajar la salida puede dejar la estadía por debajo del mínimo.
  if (input.checkIn || input.checkOut || input.roomId || input.numGuests !== undefined) {
    const reglas = await reglasDeHabitacion(newRoomId, current.ratePlanId);
    const violacion = violacionDeReglas({
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      numGuests: input.numGuests ?? current.numGuests,
      ...reglas,
      validarIngreso: newCheckIn !== currentCheckIn,
    });
    if (violacion) throw new ReglaDeReservaError(violacion);
  }

  // If dates are changing, check availability
  if (input.checkIn || input.checkOut || input.roomId) {

    const available = await isRoomAvailable(newRoomId, newCheckIn, newCheckOut, id);
    if (!available) {
      throw new Error(`Room is not available for the requested dates`);
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.update({
      where: { id },
      data: {
        ...(input.checkIn && { checkIn: new Date(input.checkIn) }),
        ...(input.checkOut && { checkOut: new Date(input.checkOut) }),
        ...(input.numGuests !== undefined && { numGuests: input.numGuests }),
        ...(input.status && { status: input.status }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.roomId && { roomId: input.roomId }),
      },
      include: {
        room: { select: { number: true } },
        guest: { select: { name: true, phone: true } },
      },
    });

    await tx.auditLog.create({
      data: {
        reservationId: id,
        action: "MODIFIED",
        before: current as object,
        after: res as object,
        performedBy,
      },
    });

    return res;
  });

  // Update Google Calendar event if one exists
  if (current.calendarEventId) {
    await updateCalendarEvent(current.calendarEventId, {
      code:       current.code,
      guestName:  updated.guestName ?? updated.guest.name,
      roomNumber: updated.room.number,
      checkIn:    updated.checkIn,
      checkOut:   updated.checkOut,
      numGuests:  updated.numGuests,
    });
  }

  return updated;
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

export async function cancelReservation(id: string, performedBy = "admin") {
  const current = await prisma.reservation.findUniqueOrThrow({ where: { id } });

  if (["CANCELLED", "CHECKED_OUT"].includes(current.status)) {
    throw new Error(`Reservation is already ${current.status}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    await tx.auditLog.create({
      data: {
        reservationId: id,
        action: "CANCELLED",
        before: current as object,
        after: res as object,
        performedBy,
      },
    });

    return res;
  });

  // Remove Google Calendar event (fire-and-forget)
  if (current.calendarEventId) {
    await deleteCalendarEvent(current.calendarEventId);
  }

  return updated;
}

// ─── Query ────────────────────────────────────────────────────────────────────

export async function findReservationByCode(code: string) {
  return prisma.reservation.findUnique({
    where: { code },
    include: {
      room: { select: { number: true, floor: true } },
      guest: { select: { name: true, phone: true, email: true } },
      ratePlan: { select: { name: true, pricePerNight: true } },
    },
  });
}

export async function listReservations(hotelId: string, options?: {
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}) {
  const { status, from, to, page = 1, pageSize = 20 } = options ?? {};
  const skip = (page - 1) * pageSize;

  const where = {
    hotelId,
    ...(status && { status: status as never }),
    ...(from && { checkIn: { gte: new Date(from) } }),
    ...(to && { checkOut: { lte: new Date(to) } }),
  };

  const [reservations, total] = await prisma.$transaction([
    prisma.reservation.findMany({
      where,
      include: {
        room: { select: { number: true } },
        guest: { select: { name: true, phone: true } },
      },
      orderBy: { checkIn: "asc" },
      skip,
      take: pageSize,
    }),
    prisma.reservation.count({ where }),
  ]);

  return { reservations, total, page, pageSize, pages: Math.ceil(total / pageSize) };
}
