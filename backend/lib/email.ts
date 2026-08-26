/**
 * Envío de emails con Resend.
 *
 * Sólo se manda un email: la confirmación de la reserva, cuando Mercado Pago
 * acredita el pago. Lleva un QR con el código RML para que recepción lo escanee
 * al check-in.
 *
 * El canal principal sigue siendo WhatsApp. El email es complementario y
 * OPCIONAL: si el huésped no dio uno, o si Resend no está configurado, la
 * reserva se confirma igual y nada falla. Ninguna función de este módulo lanza.
 */

import { Resend } from "resend";
import QRCode from "qrcode";

/**
 * Remitente. Resend exige un dominio verificado para usar una dirección propia;
 * sin eso, `onboarding@resend.dev` sólo puede escribirle al dueño de la cuenta.
 */
const FROM = process.env.EMAIL_FROM ?? "Roomly <onboarding@resend.dev>";

let cliente: Resend | null = null;

function getCliente(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null; // email deshabilitado
  if (!cliente) cliente = new Resend(apiKey);
  return cliente;
}

/** El QR codifica sólo el código RML: recepción lo escanea y lo busca. */
async function generarQR(code: string): Promise<string> {
  return QRCode.toDataURL(code, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
    color: { dark: "#0E1A19", light: "#FFFFFF" },
  }).then((dataUrl) => dataUrl.replace(/^data:image\/png;base64,/, ""));
}

const fmtFecha = (d: Date) =>
  d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });

const fmtMonto = (n: number) => `$${n.toLocaleString("es-AR")}`;

export type ConfirmacionReserva = {
  to: string;
  code: string;
  hotelName: string;
  hotelEmail: string | null;
  hotelPhone: string | null;
  guestName: string;
  roomNumber: string;
  checkIn: Date;
  checkOut: Date;
  numGuests: number;
  montoPagado: number;
  esSenia: boolean;
  totalReserva: number;
};

/**
 * Manda la confirmación de reserva con el QR embebido.
 *
 * @returns el id del email en Resend, o `null` si no se pudo mandar.
 */
export async function enviarConfirmacionReserva(
  datos: ConfirmacionReserva
): Promise<string | null> {
  const resend = getCliente();
  if (!resend) {
    console.warn("[email] RESEND_API_KEY no configurada; no se envió la confirmación.");
    return null;
  }

  try {
    const qr = await generarQR(datos.code);
    const noches = Math.round(
      (datos.checkOut.getTime() - datos.checkIn.getTime()) / 86400000
    );
    const saldo = datos.totalReserva - datos.montoPagado;

    const { data, error } = await resend.emails.send({
      from: FROM,
      to: [datos.to],
      subject: `Reserva ${datos.code} confirmada – ${datos.hotelName}`,
      html: plantilla(datos, noches, saldo),
      text: textoPlano(datos, noches, saldo),
      attachments: [
        {
          filename: `${datos.code}.png`,
          content: qr,
          contentId: "qr-reserva",
        },
      ],
    });

    if (error) {
      console.error("[email] Resend devolvió error:", error);
      return null;
    }
    return data?.id ?? null;
  } catch (err) {
    console.error("[email] no se pudo enviar la confirmación:", err);
    return null;
  }
}

// ─── Plantillas ───────────────────────────────────────────────────────────────

/**
 * HTML con estilos en línea y tablas: los clientes de correo no soportan hojas
 * de estilo externas, y Outlook ignora buena parte de flexbox y grid.
 */
function plantilla(d: ConfirmacionReserva, noches: number, saldo: number): string {
  const fila = (etiqueta: string, valor: string) => `
    <tr>
      <td style="padding:8px 0;color:#566B68;font-size:14px;">${etiqueta}</td>
      <td style="padding:8px 0;color:#0E1A19;font-size:14px;font-weight:600;text-align:right;">${valor}</td>
    </tr>`;

  return `<!doctype html>
<html lang="es">
<body style="margin:0;padding:0;background:#F3F6F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F6F5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:8px;overflow:hidden;">

        <tr><td style="background:#0F6E68;padding:28px 32px;">
          <div style="color:#FFFFFF;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;opacity:.85;">${d.hotelName}</div>
          <div style="color:#FFFFFF;font-size:24px;font-weight:700;margin-top:6px;">Tu reserva está confirmada</div>
        </td></tr>

        <tr><td style="padding:32px;">
          <p style="margin:0 0 24px;color:#0E1A19;font-size:16px;line-height:1.5;">
            Hola ${d.guestName}, recibimos tu pago y tu reserva quedó confirmada.
            Te esperamos.
          </p>

          <div style="text-align:center;padding:24px;background:#F3F6F5;border-radius:6px;margin-bottom:24px;">
            <div style="color:#566B68;font-size:12px;letter-spacing:1.2px;text-transform:uppercase;">Código de reserva</div>
            <div style="color:#0F6E68;font-size:30px;font-weight:700;letter-spacing:1px;margin:6px 0 16px;">${d.code}</div>
            <img src="cid:qr-reserva" alt="Código QR de la reserva ${d.code}" width="180" height="180" style="display:block;margin:0 auto;border-radius:4px;">
            <div style="color:#566B68;font-size:12px;margin-top:12px;">Mostralo al llegar</div>
          </div>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #D6DFDD;">
            ${fila("Habitación", d.roomNumber)}
            ${fila("Check-in", fmtFecha(d.checkIn))}
            ${fila("Check-out", fmtFecha(d.checkOut))}
            ${fila("Noches", String(noches))}
            ${fila("Huéspedes", String(d.numGuests))}
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #D6DFDD;margin-top:8px;">
            ${fila(d.esSenia ? "Seña abonada (15%)" : "Pago total", fmtMonto(d.montoPagado))}
            ${saldo > 0 ? fila("Saldo a abonar al llegar", fmtMonto(saldo)) : ""}
          </table>

          ${
            d.hotelEmail || d.hotelPhone
              ? `<p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #D6DFDD;color:#566B68;font-size:13px;line-height:1.6;">
                   ¿Necesitás cambiar algo? Escribinos:<br>
                   ${d.hotelEmail ? `${d.hotelEmail}<br>` : ""}${d.hotelPhone ?? ""}
                 </p>`
              : ""
          }
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Alternativa en texto plano: mejora la entregabilidad y cubre clientes sin HTML. */
function textoPlano(d: ConfirmacionReserva, noches: number, saldo: number): string {
  return [
    `${d.hotelName} — tu reserva está confirmada`,
    ``,
    `Hola ${d.guestName}, recibimos tu pago y tu reserva quedó confirmada.`,
    ``,
    `Código de reserva: ${d.code}`,
    `Habitación: ${d.roomNumber}`,
    `Check-in: ${fmtFecha(d.checkIn)}`,
    `Check-out: ${fmtFecha(d.checkOut)}`,
    `Noches: ${noches}`,
    `Huéspedes: ${d.numGuests}`,
    ``,
    `${d.esSenia ? "Seña abonada (15%)" : "Pago total"}: ${fmtMonto(d.montoPagado)}`,
    saldo > 0 ? `Saldo a abonar al llegar: ${fmtMonto(saldo)}` : ``,
    ``,
    d.hotelEmail ? `Contacto: ${d.hotelEmail}` : ``,
    d.hotelPhone ?? ``,
  ]
    .filter((l) => l !== ``)
    .join("\n");
}
