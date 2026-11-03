import { NextRequest, NextResponse } from "next/server";
import { UpdateReservationSchema } from "@/lib/validations";
import { updateReservation, ReglaDeReservaError } from "@/services/reservation.service";

/**
 * GET /api/v1/reservations/modificar?id=xxx[&checkIn=YYYY-MM-DD][&checkOut=YYYY-MM-DD][&numGuests=N]
 * Flat query-param version for n8n AI tools (avoids $fromAI in URL path).
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

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
    console.error("[GET /reservations/modificar]", err);
    return NextResponse.json({ error: message }, { status });
  }
}
