import { NextRequest, NextResponse } from "next/server";
import { UpdateReservationSchema } from "@/lib/validations";
import { updateReservation, ReglaDeReservaError } from "@/services/reservation.service";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/reservations/:id/modificar
 * Versión GET de modificar reserva para compatibilidad con n8n + Gemini.
 * Query params: checkIn, checkOut, numGuests (todos opcionales)
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const { searchParams } = req.nextUrl;

    const body: Record<string, unknown> = {};
    const checkIn   = searchParams.get("checkIn");
    const checkOut  = searchParams.get("checkOut");
    const numGuests = searchParams.get("numGuests");
    if (checkIn)   body.checkIn   = checkIn;
    if (checkOut)  body.checkOut  = checkOut;
    if (numGuests) body.numGuests = numGuests;

    const parsed = UpdateReservationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation error", details: parsed.error.flatten() },
        { status: 422 }
      );
    }

    const updated = await updateReservation(id, parsed.data);
    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    const status  = message.includes("not available") ? 409 : err instanceof ReglaDeReservaError ? 422 : 500;
    console.error("[GET /reservations/:id/modificar]", err);
    return NextResponse.json({ error: message }, { status });
  }
}
