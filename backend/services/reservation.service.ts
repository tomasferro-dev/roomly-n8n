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
  const guestRecord = await prisma.guest.upsert({
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

  // If dates are changing, check availability
  if (input.checkIn || input.checkOut || input.roomId) {
    const newRoomId = input.roomId ?? current.roomId;
    const newCheckIn = input.checkIn ?? current.checkIn.toISOString().split("T")[0];
    const newCheckOut = input.checkOut ?? current.checkOut.toISOString().split("T")[0];

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
