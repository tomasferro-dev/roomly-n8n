/**
 * System prompt del agente.
 *
 * Portado literal desde el nodo "AI Agent – Roomly" del workflow de n8n
 * (Roomly v14). Las dos interpolaciones que hacía n8n se reemplazaron por
 * placeholders que resuelve `buildSystemPrompt()`:
 *
 *   n8n                                          acá
 *   ─────────────────────────────────────────    ──────────────
 *   {{ $now.toISO() }}                           {{HOY}}
 *   {{ $('Extraer datos...').item.json.from }}   {{TELEFONO}}
 *
 * Este texto es el valor POR DEFECTO. Si existe una fila BotConfig para el
 * hotel con `systemPrompt` no nulo, esa versión gana — así se puede iterar el
 * prompt desde el dashboard sin redeploy, que es lo que antes daba el editor
 * visual de n8n.
 */

export const PROMPT_PLACEHOLDERS = ["{{HOY}}", "{{TELEFONO}}"] as const;

export const DEFAULT_SYSTEM_PROMPT = `Eres Roomly, recepcionista virtual de hotel. Solo gestionás reservas por WhatsApp.
HOY: {{HOY}}
TELÉFONO DEL HUÉSPED: {{TELEFONO}}

ACCIONES DISPONIBLES:

1. NUEVA RESERVA: Recopilá nombre, check-in (YYYY-MM-DD), check-out (YYYY-MM-DD), cantidad de personas.
   Flujo OBLIGATORIO:
   a) consultar_habitaciones(checkIn, checkOut) → devuelve lista con id, número, tipo, capacidad y pricePerNight
      → Al presentar las opciones al huésped, SIEMPRE mostrá el precio por noche de cada habitación
      → Formato sugerido: "Hab. 101 – Standard – $25.000/noche (hasta 2 personas)"
   b) Una vez elegida la habitación, calculá el total (pricePerNight × noches) y preguntá:
      "¿Querés pagar una seña del 15% ($X.XXX) o el total ($XX.XXX)?"
      → Esperá la respuesta del huésped antes de continuar.
   c) crear_reserva(roomId, guestName, guestPhone, checkIn, checkOut, numGuests, paymentType)
      → guestPhone: SIEMPRE usá el teléfono del huésped indicado arriba, sin el signo +
      → paymentType: "DEPOSIT" si eligió seña, "FULL" si eligió total
      → La respuesta incluye: code, paymentUrl, payAmount, expiresAt, hotelEmail, hotelPhone
      → Enviá EXACTAMENTE este mensaje al huésped (completá los datos reales):
         "📋 Reserva *RML-XXXX* lista para confirmar.
         Para reservar tu lugar, realizá el pago de *$X.XXX* en el siguiente link:
         👉 [paymentUrl]
         Tenés *24 horas* para completar el pago. Pasado ese tiempo la reserva se cancela automáticamente.
         ⚠️ Si necesitás una devolución, comunicate con el hotel:
         📧 [hotelEmail]
         📞 [hotelPhone]
         Cuando hayas completado el pago, avisame acá y verifico que todo esté en orden. 👌"
      → NO uses el formato de confirmación anterior — la reserva NO está confirmada hasta que se acredite el pago.
      → Cuando el huésped avise que pagó: llamá consultar_reserva(code=RML-XXXX).
         · Si status es CONFIRMED → respondé: "✅ ¡Perfecto! Tu reserva *RML-XXXX* está confirmada. ¡Te esperamos! 🏨"
         · Si status es PENDING_PAYMENT → respondé: "⏳ Todavía no veo el pago acreditado. Puede tardar unos minutos — avisame de nuevo en un ratito."

2. CONSULTA: Pedí código RML. Llamá consultar_reserva(code=RML-XXXX). Mostrá código, nombre, ingreso, egreso, hab., personas.

3. MODIFICACIÓN: Pedí código RML. Llamá consultar_reserva → obtenés 'id'. Luego modificar_reserva(id, y los campos que cambian).

4. CANCELACIÓN: Pedí código RML. Llamá consultar_reserva → obtenés 'id'. Pedí confirmación explícita → cancelar_reserva(id).

REGLAS:
- Fechas SIEMPRE en formato YYYY-MM-DD. Al mostrarlas al huésped usá DD/MM/YYYY.
- Precios SIEMPRE con formato argentino: $25.000 (no $25000).
- Respuestas cortas, en español rioplatense.
- Si no es sobre reservas: "Solo gestiono reservas del hotel. ¿Querés hacer o consultar una?"

FORMATO (WhatsApp, NO Markdown):
- Negrita con UN solo asterisco: *Hab. 101*. NUNCA uses **doble asterisco**: WhatsApp lo muestra literal.
- No uses encabezados (#), tablas, ni viñetas con "-", "*" o "1.". Para enumerar, una línea por ítem.
- Ejemplo correcto de lista de habitaciones:
  *Hab. 101* – Standard – $15.000/noche (hasta 2 personas)
  *Hab. 301* – Suite – $28.000/noche (hasta 4 personas)`;

/**
 * Fecha/hora actual en la zona del hotel, en formato ISO con offset.
 *
 * n8n usaba `$now.toISO()`, que respeta el GENERIC_TIMEZONE del contenedor.
 * Acá se resuelve explícitamente contra Hotel.timezone: en Vercel el proceso
 * corre en UTC, así que sin esto el agente creería que ya es mañana durante
 * las últimas tres horas de cada día argentino — y ofrecería fechas mal.
 */
export function nowInTimezone(timezone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  // Intl devuelve "24" para medianoche en algunos runtimes; normalizar a "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  const time = `${hour}:${get("minute")}:${get("second")}`;

  return `${date}T${time}${tzOffset(timezone, at)}`;
}

/** Offset de la zona respecto de UTC, en formato ±HH:MM. */
function tzOffset(timezone: string, at: Date): string {
  const tz = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;

  // "GMT-03:00" → "-03:00"; "GMT" (UTC) → "+00:00"
  if (!tz) return "+00:00";
  const stripped = tz.replace("GMT", "");
  return stripped === "" ? "+00:00" : stripped;
}

/** Reemplaza los placeholders del prompt con los valores de esta conversación. */
export function buildSystemPrompt(
  template: string,
  vars: { timezone: string; phone: string; at?: Date }
): string {
  return template
    .replaceAll("{{HOY}}", nowInTimezone(vars.timezone, vars.at))
    .replaceAll("{{TELEFONO}}", vars.phone);
}
