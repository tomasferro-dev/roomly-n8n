import { NextRequest, NextResponse } from "next/server";
import { CreateReservationSchema } from "@/lib/validations";
import { createReservation, ReglaDeReservaError } from "@/services/reservation.service";
import { createPaymentPreference } from "@/services/payment.service";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/v1/reservations/crear
 * Versión GET de crear reserva para compatibilidad con n8n + Gemini.
 * Query params: hotelId, roomId, guestName, guestPhone, checkIn, checkOut, numGuests, channel, code
 *
 * roomId acepta tanto el ID de base de datos (cuid) como el número de habitación ("101", "302", etc.)
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;

    const hotelId  = searchParams.get("hotelId");
    let   roomId   = searchParams.get("roomId");

    // Si roomId no parece un cuid (no empieza con 'c' o es muy corto), intenta
    // buscarlo como número de habitación dentro del hotel.
    if (roomId && hotelId && !/^c[a-z0-9]{20,}$/.test(roomId)) {
      const room = await prisma.room.findUnique({
        where: { hotelId_number: { hotelId, number: roomId } },
        select: { id: true },
      });
      if (room) roomId = room.id;
    }

    const paymentTypeRaw = searchParams.get("paymentType");
    const paymentType    = (paymentTypeRaw === "DEPOSIT" || paymentTypeRaw === "FULL")
      ? paymentTypeRaw
      : undefined;

    const body = {
      hotelId,
      roomId,
      guestName:   searchParams.get("guestName"),
      guestPhone:  req.headers.get("x-guest-phone") ?? searchParams.get("guestPhone"),
      checkIn:     searchParams.get("checkIn"),
      checkOut:    searchParams.get("checkOut"),
      numGuests:   searchParams.get("numGuests"),
      channel:     searchParams.get("channel") ?? "WHATSAPP",
      code:        req.headers.get("x-reservation-code") ?? searchParams.get("code") ?? undefined,
      paymentType,
    };

    const parsed = CreateReservationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation error", details: parsed.error.flatten() },
        { status: 422 }
      );
    }

    const reservation = await createReservation(parsed.data);

    // Si hay tipo de pago, generar la preferencia de MP y devolver la URL
    if (paymentType) {
      const payment = await createPaymentPreference(reservation.id, paymentType);
      return NextResponse.json(
        {
          code:        reservation.code,
          status:      reservation.status,
          paymentUrl:  payment.paymentUrl,
          payAmount:   payment.payAmount,
          totalPrice:  payment.totalPrice,
          paymentType: payment.paymentType,
          expiresAt:   payment.expiresAt,
          hotelEmail:  payment.hotelEmail,
          hotelPhone:  payment.hotelPhone,
        },
        { status: 201 }
      );
    }

    return NextResponse.json(reservation, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message.includes("not available") ? 409 : err instanceof ReglaDeReservaError ? 422 : 500;
    console.error("[GET /reservations/crear]", err);
    return NextResponse.json({ error: message }, { status });
  }
}
