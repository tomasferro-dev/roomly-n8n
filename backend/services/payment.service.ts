import { Preference, Payment as MPPayment } from "mercadopago";
import { mpClient } from "@/lib/mercadopago";
import { prisma } from "@/lib/prisma";
import { scheduleHousekeeping } from "./reservation.service";
import { enviarTexto } from "@/lib/channels/whatsapp";
import { enviarConfirmacionReserva } from "@/lib/email";
import { reclamarEvento } from "@/lib/dedup";

/**
 * URL pública, sin barra al final.
 *
 * El `replace` no es cosmético. Si NEXTAUTH_URL termina en "/", concatenarle
 * "/api/v1/payments/webhook" produce una doble barra, y esa ruta devuelve un
 * 308 en vez de un 200. Mercado Pago NO sigue redirects en las notificaciones:
 * las cuenta como entrega fallida, reintenta unas pocas veces y abandona.
 *
 * El resultado es el peor posible: el huésped paga, MP cobra, y la reserva
 * queda en PENDING_PAYMENT para siempre hasta que el cron la cancela. Sin
 * ningún error visible de este lado.
 */
const BACKEND_URL = (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");

// ─── Crear preferencia de pago ────────────────────────────────────────────────

/**
 * Crea una preferencia de Mercado Pago para una reserva en estado PENDING_PAYMENT.
 * Devuelve la URL de pago y los datos del hotel para el mensaje de WhatsApp.
 *
 * @param reservationId  ID interno de la reserva
 * @param paymentType    DEPOSIT (15%) o FULL (total)
 */
export async function createPaymentPreference(
  reservationId: string,
  paymentType: "DEPOSIT" | "FULL"
) {
  const reservation = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: {
      room:     { select: { number: true, typeId: true } },
      ratePlan: { select: { pricePerNight: true } },
      hotel:    { select: { name: true, email: true, phone: true } },
    },
  });

  // Precio: usar el ratePlan de la reserva si existe,
  // sino buscar el plan vigente del tipo de habitación.
  let pricePerNight: number;
  if (reservation.ratePlan) {
    pricePerNight = Number(reservation.ratePlan.pricePerNight);
  } else {
    const plan = await prisma.ratePlan.findFirst({
      where: { typeId: reservation.room.typeId },
      orderBy: { validFrom: "desc" },
      select: { pricePerNight: true },
    });
    if (!plan) {
      throw new Error("No hay tarifa configurada para esta habitación.");
    }
    pricePerNight = Number(plan.pricePerNight);
  }

  const nights = Math.round(
    (reservation.checkOut.getTime() - reservation.checkIn.getTime()) / 86400000
  );
  const totalPrice  = pricePerNight * nights;
  const payAmount   = paymentType === "DEPOSIT" ? Math.round(totalPrice * 0.15) : totalPrice;
  const expiresAt   = new Date(Date.now() + 24 * 60 * 60 * 1000); // +24 h

  const preference = new Preference(mpClient);
  const mpResponse = await preference.create({
    body: {
      items: [
        {
          id:         reservation.id,
          title:      `${paymentType === "DEPOSIT" ? "Seña (15%)" : "Pago total"} – ${reservation.hotel.name} · Hab. ${reservation.room.number} · ${reservation.code}`,
          quantity:   1,
          unit_price: payAmount,
          currency_id: "ARS",
        },
      ],
      external_reference: reservation.id,
      notification_url:   `${BACKEND_URL}/api/v1/payments/webhook`,
      // La preferencia expira en 24 h (igual que el deadline de la reserva)
      expires:                true,
      expiration_date_from:   new Date().toISOString(),
      expiration_date_to:     expiresAt.toISOString(),
    },
  });

  // Guardar el pago en la DB
  await prisma.payment.create({
    data: {
      hotelId:       reservation.hotelId,
      reservationId: reservation.id,
      mpPreferenceId: mpResponse.id ?? undefined,
      amount:         payAmount,
      currency:       "ARS",
      status:         "PENDING",
      paymentType,
      expiresAt,
    },
  });

  // La auto-cancelación a las 24 h ya no se encola: el deadline queda en
  // Payment.expiresAt y el cron /api/cron/expire-payments barre los vencidos.
  // Un job diferido en Redis se pierde si Redis se reinicia; una fecha en la
  // base, no.

  return {
    paymentUrl:  mpResponse.init_point!,
    payAmount,
    totalPrice,
    paymentType,
    expiresAt,
    hotelEmail:  reservation.hotel.email,
    hotelPhone:  reservation.hotel.phone,
  };
}

// ─── Procesar webhook de MP ───────────────────────────────────────────────────

/**
 * Consulta el estado de un pago en MP y actualiza la DB.
 * Si el pago fue aprobado → confirma la reserva y notifica al huésped.
 */
export async function handleMPWebhook(mpPaymentId: string) {
  const paymentClient = new MPPayment(mpClient);
  const info = await paymentClient.get({ id: String(mpPaymentId) });

  const reservationId = info.external_reference;
  if (!reservationId) {
    console.warn("[MP webhook] external_reference vacío — se ignora.");
    return;
  }

  const payment = await prisma.payment.findUnique({
    where: { reservationId },
  });
  if (!payment) {
    console.warn(`[MP webhook] No existe Payment para reservationId ${reservationId}`);
    return;
  }

  const newStatus =
    info.status === "approved" ? "APPROVED" :
    info.status === "rejected" ? "REJECTED"  :
    "PENDING";

  await prisma.payment.update({
    where: { reservationId },
    data: { status: newStatus, mpPaymentId: String(info.id ?? "") },
  });

  if (newStatus === "APPROVED") {
    // Confirmar la reserva
    await prisma.$transaction(async (tx) => {
      await tx.reservation.update({
        where: { id: reservationId },
        data:  { status: "CONFIRMED" },
      });
      await tx.auditLog.create({
        data: {
          reservationId,
          action:      "PAYMENT_APPROVED",
          after:       { mpPaymentId, amount: Number(payment.amount), paymentType: payment.paymentType } as object,
          performedBy: "mercadopago",
        },
      });
    });

    // Lo que antes se encolaba al confirmarse el pago. Son dos operaciones
    // cortas, así que van inline: una cola sólo agregaba latencia y una
    // dependencia de Redis. Ya no hay job de auto-cancelación que borrar —
    // el cron ignora los pagos que no siguen en PENDING.
    await scheduleHousekeeping(reservationId);
    await notifyPaymentConfirmed(reservationId, {
      mpPaymentId,
      paymentType: payment.paymentType,
      amount:      Number(payment.amount),
    });

    console.log(`[MP webhook] Reserva ${reservationId} CONFIRMADA — pago ${mpPaymentId}`);
  }

  if (newStatus === "REJECTED") {
    console.log(`[MP webhook] Pago ${mpPaymentId} rechazado — reserva ${reservationId} sigue PENDING_PAYMENT`);
  }
}

// ─── Reconciliación: preguntarle a MP en vez de esperar el aviso ──────────────

export type ResultadoReconciliacion =
  | "CONFIRMADA"   // había un pago aprobado y se confirmó la reserva ahora
  | "EN_CURSO"     // había un pago aprobado, pero otro proceso ya lo está confirmando
  | "SIN_PAGO"     // MP no tiene ningún pago aprobado para la reserva
  | "NO_APLICA"    // la reserva no tiene un pago pendiente
  | "ERROR";       // no se pudo consultar a MP; no se sabe si hay pago

/**
 * Busca en Mercado Pago un pago aprobado para la reserva y, si lo hay, la
 * confirma con la misma lógica que el webhook.
 *
 * Existe porque el aviso de MP se puede perder: un notification_url mal
 * armado, una redirección, una caída. Pasó el 22/10/2026 — el huésped pagó, MP
 * mandó el aviso a un dominio que redirigía, y la reserva quedó pendiente con
 * la plata cobrada. Preguntar por `external_reference` (el id de la reserva)
 * no depende de que el aviso llegue.
 *
 * Reclama el mismo evento de deduplicación que el webhook ("MERCADOPAGO",
 * id del pago): si el aviso real llega al mismo tiempo, sólo uno de los dos
 * confirma y avisa al huésped. `handleMPWebhook` no es idempotente.
 *
 * Nunca lanza.
 */
export async function reconciliarPago(reservationId: string): Promise<ResultadoReconciliacion> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { reservationId },
      select: { status: true },
    });
    if (!payment || payment.status !== "PENDING") return "NO_APLICA";

    const busqueda = await new MPPayment(mpClient).search({
      options: { external_reference: reservationId },
    });
    const aprobado = busqueda.results?.find((p) => p.status === "approved" && p.id != null);
    if (!aprobado) return "SIN_PAGO";

    const mpPaymentId = String(aprobado.id);
    const meToca = await reclamarEvento("MERCADOPAGO", mpPaymentId);
    if (!meToca && !(await reclamoTrabado(mpPaymentId))) return "EN_CURSO";

    await handleMPWebhook(mpPaymentId);
    console.log(`[pagos:reconciliar] reserva ${reservationId} confirmada sin aviso de MP (pago ${mpPaymentId})`);
    return "CONFIRMADA";
  } catch (err) {
    console.warn(`[pagos:reconciliar] no se pudo consultar MP para ${reservationId}:`, err);
    return "ERROR";
  }
}

/** Pasado este tiempo, un aviso reclamado que no confirmó el pago se da por fallido. */
const RECLAMO_TRABADO_MS = 10 * 60 * 1000;

/**
 * Si el evento de este pago ya estaba reclamado pero el pago sigue PENDING
 * después de un rato, el intento anterior (webhook o reconciliación) se cortó
 * a la mitad. Sin esto, la reserva quedaría pendiente para siempre: el evento
 * reclamado impediría cualquier reintento.
 */
async function reclamoTrabado(mpPaymentId: string): Promise<boolean> {
  const evento = await prisma.processedEvent.findUnique({
    where: { provider_externalId: { provider: "MERCADOPAGO", externalId: mpPaymentId } },
    select: { receivedAt: true },
  });
  return !!evento && Date.now() - evento.receivedAt.getTime() > RECLAMO_TRABADO_MS;
}

// ─── Auto-expiración (llamada desde BullMQ) ───────────────────────────────────

/**
 * Cancela una reserva si sigue en PENDING_PAYMENT pasadas las 24 h.
 */
export async function expirePayment(reservationId: string) {
  const payment = await prisma.payment.findUnique({ where: { reservationId } });
  if (!payment || payment.status !== "PENDING") return; // ya fue pagado

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { reservationId },
      data:  { status: "EXPIRED" },
    });
    await tx.reservation.update({
      where: { id: reservationId },
      data:  { status: "CANCELLED" },
    });
    await tx.auditLog.create({
      data: {
        reservationId,
        action:      "PAYMENT_EXPIRED",
        after:       { reason: "24h sin pago" } as object,
        performedBy: "system",
      },
    });
  });

  console.log(`[Queue] Reserva ${reservationId} cancelada por falta de pago (24 h)`);
}

// ─── Notificación de pago acreditado ──────────────────────────────────────────

/**
 * Avisa al huésped que su pago se acreditó y la reserva quedó confirmada.
 *
 * Antes era el job `SEND_PAYMENT_CONFIRMED` de BullMQ, que además rebotaba el
 * mensaje contra un webhook de n8n (`/webhook/payment-confirmed`) sólo para
 * que n8n usara su credencial de WhatsApp. Ahora se manda directo.
 *
 * No lanza: si falla el aviso, el pago igual quedó acreditado y la reserva
 * confirmada. `notifiedAt` queda en null, así se puede reintentar después.
 */
export async function notifyPaymentConfirmed(
  reservationId: string,
  info: { mpPaymentId: string; paymentType: string; amount: number }
): Promise<void> {
  try {
    const res = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: {
        guest: { select: { phone: true, email: true, name: true } },
        room:  { select: { number: true } },
        hotel: { select: { name: true, email: true, phone: true } },
      },
    });
    if (!res) return;

    // El email va primero y por separado: es opcional y no debe verse afectado
    // si WhatsApp no está configurado o si el envío por WhatsApp falla.
    await enviarConfirmacionSiHayEmail(res, info);

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneNumberId) {
      console.warn("[pagos] WHATSAPP_PHONE_NUMBER_ID no configurado; no se avisó al huésped.");
      return;
    }

    const typeLabel  = info.paymentType === "DEPOSIT" ? "seña (15%)" : "pago total";
    const fmtFecha   = (d: Date) =>
      d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });

    const msg =
      `✅ ¡Pago recibido! Tu reserva *${res.code}* en ${res.hotel.name} está *confirmada*.\n` +
      `🛏️ Hab. ${res.room.number} · Check-in: ${fmtFecha(res.checkIn)} · Check-out: ${fmtFecha(res.checkOut)}\n` +
      `💰 Se acreditó tu ${typeLabel} de $${info.amount.toLocaleString("es-AR")}.\n\n` +
      `¡Te esperamos! 🏨`;

    await enviarTexto(phoneNumberId, res.guest.phone, msg);

    await prisma.payment.update({
      where: { reservationId },
      data:  { notifiedAt: new Date() },
    });
  } catch (err) {
    console.error("[pagos] no se pudo avisar del pago acreditado:", err);
  }
}

// ─── Barrido de vencimientos (lo llama el cron) ───────────────────────────────

/**
 * Cancela las reservas que quedaron sin pagar.
 *
 * Reemplaza al job diferido a 24 h de BullMQ. Barrer por fecha es más robusto
 * que programar un job: si el proceso que tenía que ejecutarlo se cayó, el job
 * se pierde para siempre; una fecha en la base sigue ahí y el próximo barrido
 * la levanta.
 *
 * Antes de cancelar nada, reconcilia cada pago pendiente contra Mercado Pago
 * (ver reconciliarPago): confirma los que ya se pagaron aunque el aviso no
 * haya llegado.
 *
 * Cubre dos casos de cancelación:
 *   1. Pagos vencidos — el equivalente directo del job viejo.
 *   2. Reservas PENDING_PAYMENT SIN fila de Payment. Pasa si la preferencia de
 *      Mercado Pago falla después de haberse creado la reserva: quedan
 *      bloqueando la habitación sin que nada las limpie. Sin este barrido,
 *      para siempre.
 */
export async function expirePendingPayments(): Promise<{
  confirmadas: number;
  vencidas: number;
  huerfanas: number;
}> {
  const ahora = new Date();

  // Todos los pagos pendientes, vencidos o no, se reconcilian contra MP: los
  // vigentes para confirmarlos aunque el aviso se haya perdido, y los vencidos
  // para no cancelar NUNCA una reserva que el huésped ya pagó.
  const pendientes = await prisma.payment.findMany({
    where: { status: "PENDING" },
    select: { reservationId: true, expiresAt: true },
    orderBy: { expiresAt: "asc" },
    take: MAX_RECONCILIAR_POR_BARRIDO,
  });

  let confirmadas = 0;
  let vencidas = 0;

  for (const { reservationId, expiresAt } of pendientes) {
    const resultado = await reconciliarPago(reservationId);
    const accion = accionTrasReconciliar(resultado, expiresAt, ahora);
    if (accion === "CONFIRMADA") {
      confirmadas++;
      continue;
    }
    if (accion === "ESPERAR") {
      if (expiresAt < ahora) {
        console.warn(`[cron] ${reservationId} vencida pero sin respuesta concluyente de MP (${resultado}); no se cancela todavía`);
      }
      continue;
    }

    try {
      await expirePayment(reservationId);
      vencidas++;
    } catch (err) {
      console.error(`[cron] no se pudo expirar ${reservationId}:`, err);
    }
  }

  // Reservas huérfanas: PENDING_PAYMENT, sin Payment, y con margen suficiente
  // como para descartar una que se esté creando justo en este momento.
  const margen = new Date(ahora.getTime() - 30 * 60 * 1000);
  const huerfanas = await prisma.reservation.findMany({
    where: { status: "PENDING_PAYMENT", payment: null, createdAt: { lt: margen } },
    select: { id: true, code: true },
  });

  for (const r of huerfanas) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.reservation.update({
          where: { id: r.id },
          data:  { status: "CANCELLED" },
        });
        await tx.auditLog.create({
          data: {
            reservationId: r.id,
            action:      "PAYMENT_EXPIRED",
            after:       { reason: "PENDING_PAYMENT sin preferencia de pago" } as object,
            performedBy: "system",
          },
        });
      });
      console.log(`[cron] reserva huérfana ${r.code} cancelada`);
    } catch (err) {
      console.error(`[cron] no se pudo cancelar la huérfana ${r.code}:`, err);
    }
  }

  return { confirmadas, vencidas, huerfanas: huerfanas.length };
}

/**
 * Qué hacer con un pago pendiente después de preguntarle a MP. Función pura,
 * probada en agent:check, porque un error acá cancela reservas ya pagadas.
 *
 *   CONFIRMADA → se confirmó ahora.
 *   EXPIRAR    → vencido y MP confirmó que no hay pago aprobado.
 *   ESPERAR    → vigente, o vencido sin respuesta concluyente de MP. Si MP no
 *                responde, se cancela igual pasado un día de vencido, para que
 *                una caída larga de MP no deje habitaciones bloqueadas.
 */
export function accionTrasReconciliar(
  resultado: ResultadoReconciliacion,
  expiresAt: Date,
  ahora: Date
): "CONFIRMADA" | "EXPIRAR" | "ESPERAR" {
  if (resultado === "CONFIRMADA") return "CONFIRMADA";
  if (expiresAt >= ahora) return "ESPERAR";
  if (resultado === "SIN_PAGO") return "EXPIRAR";
  const venceHaceMucho = ahora.getTime() - expiresAt.getTime() > GRACIA_SIN_RESPUESTA_MS;
  return resultado === "ERROR" && venceHaceMucho ? "EXPIRAR" : "ESPERAR";
}

/** Tope de consultas a MP por barrido, para no exceder el maxDuration de la función. */
const MAX_RECONCILIAR_POR_BARRIDO = 50;

/** Si MP no responde, una reserva vencida se cancela igual pasado este margen. */
const GRACIA_SIN_RESPUESTA_MS = 24 * 60 * 60 * 1000;

/**
 * Manda la confirmación por email, si el huésped dejó uno.
 *
 * El email es un canal secundario y opcional: WhatsApp sigue siendo el
 * principal. Por eso nunca lanza y no interrumpe nada si falla — una reserva
 * confirmada no puede quedar a medias porque el correo rebotó.
 */
async function enviarConfirmacionSiHayEmail(
  res: {
    code: string;
    checkIn: Date;
    checkOut: Date;
    numGuests: number;
    guestName: string | null;
    guest: { email: string | null; name: string };
    room: { number: string };
    hotel: { name: string; email: string | null; phone: string | null };
  },
  info: { paymentType: string; amount: number }
): Promise<void> {
  if (!res.guest.email) {
    await registrarEmail(res.code, "EMAIL_OMITIDO", { motivo: "el huésped no dejó email" });
    return;
  }

  const esSenia = info.paymentType === "DEPOSIT";
  // La seña es el 15%, así que el total se reconstruye desde lo pagado.
  const totalReserva = esSenia ? Math.round(info.amount / 0.15) : info.amount;

  const id = await enviarConfirmacionReserva({
    to: res.guest.email,
    code: res.code,
    hotelName: res.hotel.name,
    hotelEmail: res.hotel.email,
    hotelPhone: res.hotel.phone,
    guestName: res.guestName ?? res.guest.name,
    roomNumber: res.room.number,
    checkIn: res.checkIn,
    checkOut: res.checkOut,
    numGuests: res.numGuests,
    montoPagado: info.amount,
    esSenia,
    totalReserva,
  });

  // Dejar rastro pase lo que pase. Antes, si el envío fallaba, sólo quedaba
  // una línea en los logs de Vercel: desde la base era indistinguible de "el
  // huésped no dio email" o de "el código no está desplegado". Eso convertía
  // cualquier diagnóstico en adivinanza.
  if (id) {
    console.log(`[email] confirmación de ${res.code} enviada a ${res.guest.email} (${id})`);
    await registrarEmail(res.code, "EMAIL_ENVIADO", { to: res.guest.email, resendId: id });
  } else {
    console.warn(`[email] no se pudo enviar la confirmación de ${res.code}`);
    await registrarEmail(res.code, "EMAIL_FALLIDO", {
      to: res.guest.email,
      motivo: process.env.RESEND_API_KEY
        ? "Resend rechazó el envío — ver los logs de la función"
        : "RESEND_API_KEY no está configurada en este deploy",
    });
  }
}

/**
 * Anota el resultado del envío en AuditLog.
 *
 * Se usa AuditLog en vez de una columna nueva para no migrar el esquema por
 * una traza: ya tiene reservationId, acción y un JSON libre, y es donde
 * naturalmente se busca "qué le pasó a esta reserva".
 */
async function registrarEmail(
  code: string,
  accion: "EMAIL_ENVIADO" | "EMAIL_FALLIDO" | "EMAIL_OMITIDO",
  detalle: Record<string, unknown>
): Promise<void> {
  try {
    const r = await prisma.reservation.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!r) return;
    await prisma.auditLog.create({
      data: { reservationId: r.id, action: accion, after: detalle as object, performedBy: "system" },
    });
  } catch (err) {
    console.warn("[email] no se pudo registrar el resultado del envío:", err);
  }
}
