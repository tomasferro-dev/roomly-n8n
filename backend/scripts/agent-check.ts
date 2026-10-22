/**
 * Chequeos de las partes puras del agente — no necesitan base ni API key.
 *
 *   npm run agent:check
 *
 * Cubre lo que n8n resolvía por su cuenta y acá pasó a ser código propio:
 * la conversión de zona horaria para "HOY" (en Vercel el proceso corre en UTC),
 * la interpolación de los placeholders del prompt portado, y la normalización
 * del historial que Gemini exige que abra con un turno del usuario.
 */

import "dotenv/config";
import { nowInTimezone, buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "../lib/agent/prompt";
import { normalizeHistory } from "../lib/agent/memory";
import { extraerMensaje, normalizarDestinatario } from "../lib/channels/whatsapp";
import { verifyMetaSignature, verifyMercadoPagoSignature } from "../lib/signatures";
import { seudonimizarTelefono, seudonimizarTelefonosEnJson } from "../lib/privacy";
import { accionTrasReconciliar } from "../services/payment.service";

const TZ = "America/Argentina/Buenos_Aires";
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${label}\n    esperado: ${JSON.stringify(expected)}\n    obtenido: ${JSON.stringify(actual)}`);
}

// El caso que importa: 01:30 UTC del 16/09 es todavía 22:30 del 15/09 en Argentina.
// En Vercel el proceso corre en UTC, así que sin conversión el agente creería
// que ya es 16 y ofrecería fechas equivocadas.
check("22:30 ARG del 15-sep (01:30 UTC del 16)",
  nowInTimezone(TZ, new Date("2026-09-16T01:30:00Z")),
  "2026-09-15T22:30:00-03:00");

check("medianoche ARG",
  nowInTimezone(TZ, new Date("2026-09-16T03:00:00Z")),
  "2026-09-16T00:00:00-03:00");

check("mediodia ARG",
  nowInTimezone(TZ, new Date("2026-09-15T15:00:00Z")),
  "2026-09-15T12:00:00-03:00");

check("UTC devuelve +00:00",
  nowInTimezone("UTC", new Date("2026-09-15T15:00:00Z")),
  "2026-09-15T15:00:00+00:00");

check("Madrid en verano (+02:00)",
  nowInTimezone("Europe/Madrid", new Date("2026-07-15T10:00:00Z")),
  "2026-07-15T12:00:00+02:00");

// El resultado tiene que ser parseable de vuelta al mismo instante.
const iso = nowInTimezone(TZ, new Date("2026-09-16T01:30:00Z"));
check("round-trip a UTC", new Date(iso).toISOString(), "2026-09-16T01:30:00.000Z");

// Placeholders
const prompt = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, {
  timezone: TZ, phone: "5493510000000", at: new Date("2026-09-16T01:30:00Z"),
});
check("no quedan placeholders sin resolver", /\{\{[A-Z]+\}\}/.test(prompt), false);
check("interpola el telefono", prompt.includes("TELÉFONO DEL HUÉSPED: 5493510000000"), true);
check("interpola la fecha local", prompt.includes("HOY: 2026-09-15T22:30:00-03:00"), true);
check("conserva las reglas del prompt de n8n", prompt.includes("consultar_habitaciones(checkIn, checkOut)"), true);

// Reglas de formato para WhatsApp: el modelo tiraba Markdown (**negrita**,
// viñetas con "*   ") que WhatsApp muestra literal.
check("el prompt prohibe el doble asterisco", prompt.includes("NUNCA uses **doble asterisco**"), true);
check("el prompt da el ejemplo de lista sin viñetas", prompt.includes("*Hab. 101* – Standard"), true);

// normalizeHistory: Gemini exige que el historial abra con un turno de usuario.
const u = (t: string) => ({ role: "user", parts: [{ text: t }] });
const m = (t: string) => ({ role: "model", parts: [{ text: t }] });
check("descarta turnos del modelo al inicio",
  normalizeHistory([m("aviso de pago"), u("hola"), m("buenas")]).map(c => c.role),
  ["user", "model"]);
check("deja intacto un historial que ya abre en user",
  normalizeHistory([u("hola"), m("buenas")]).map(c => c.role),
  ["user", "model"]);
check("historial todo-modelo queda vacio", normalizeHistory([m("a"), m("b")]), []);
check("historial vacio", normalizeHistory([]), []);

// ─── Canal de WhatsApp ────────────────────────────────────────────────────────
// Payloads con la forma real que manda Meta al webhook.

const sobre = (value: unknown) => ({ entry: [{ changes: [{ value }] }] });

const mensajeTexto = sobre({
  metadata: { phone_number_id: "123456789" },
  messages: [{ id: "wamid.ABC", from: "5493510000000", type: "text", timestamp: "1755880000", text: { body: "hola" } }],
});

check("extrae un mensaje de texto",
  extraerMensaje(mensajeTexto),
  { messageId: "wamid.ABC", phoneNumberId: "123456789", from: "5493510000000", text: "hola", timestamp: "1755880000" });

// Meta envuelve el payload cuando llega vía un proxy; n8n contemplaba las dos formas.
check("acepta el payload envuelto en body",
  extraerMensaje({ body: mensajeTexto })?.text, "hola");

// Los avisos de entrega y lectura llegan al MISMO webhook. Procesarlos como
// mensajes haría que el bot se conteste a sí mismo.
check("ignora los avisos de estado (statuses)",
  extraerMensaje(sobre({ metadata: { phone_number_id: "1" }, statuses: [{ id: "wamid.X", status: "delivered" }] })),
  null);

check("ignora mensajes que no son texto (audio, imagen)",
  extraerMensaje(sobre({ metadata: { phone_number_id: "1" }, messages: [{ id: "w", from: "54", type: "image", image: {} }] })),
  null);

check("ignora un texto vacio",
  extraerMensaje(sobre({ metadata: { phone_number_id: "1" }, messages: [{ id: "w", from: "54", type: "text", text: { body: "   " } }] })),
  null);

check("tolera un payload sin forma conocida", extraerMensaje({ cualquiera: true }), null);
check("tolera null", extraerMensaje(null), null);

// La Cloud API argentina espera el numero SIN el 9 de movil.
check("saca el 9 de los moviles argentinos", normalizarDestinatario("5493510000000"), "543510000000");
check("no toca un fijo argentino", normalizarDestinatario("543510000000"), "543510000000");
check("no toca numeros de otros paises", normalizarDestinatario("5491112345678".replace("549","34")), "341112345678");

// ─── Firmas de webhooks ───────────────────────────────────────────────────────
// Valores esperados calculados aparte con Python (hmac + hashlib), no con el
// mismo código que se prueba.

// Meta escapa los no ASCII: "café" llega como caf + barra invertida + u00e9.
// La barra se arma con fromCharCode para que ningún editor la reinterprete.
const BARRA = String.fromCharCode(92);
const cuerpoMeta = `{"entry":[{"changes":[{"value":{"messages":[{"text":{"body":"caf${BARRA}u00e9"}}]}}]}]}`;
const firmaMeta = "sha256=0647e81b336aa45846bfdbaeb8c33319e30691dc1fa8fe65dab84eb648d49c57";
check("Meta: el cuerpo de prueba trae el escape literal", cuerpoMeta.length, 80);

check("Meta: firma válida sobre el cuerpo crudo",
  verifyMetaSignature(cuerpoMeta, firmaMeta, "app-secret-de-prueba"), true);
check("Meta: rechaza con otro App Secret",
  verifyMetaSignature(cuerpoMeta, firmaMeta, "otro-secreto"), false);
check("Meta: rechaza el JSON re-serializado (é sin escapar)",
  verifyMetaSignature(JSON.stringify(JSON.parse(cuerpoMeta)), firmaMeta, "app-secret-de-prueba"), false);
check("Meta: rechaza sin header", verifyMetaSignature(cuerpoMeta, null, "app-secret-de-prueba"), false);
check("Meta: rechaza sin prefijo sha256=",
  verifyMetaSignature(cuerpoMeta, firmaMeta.slice(7), "app-secret-de-prueba"), false);

const mp = { requestId: "bb56a2f1-6aae-46ac-982e-9dcd3581d08e", dataId: "123456", secret: "mp-secret-de-prueba" };
check("Mercado Pago: firma válida",
  verifyMercadoPagoSignature({ ...mp, header: "ts=1704908010,v1=ab7d76bb7bc6e1d09a0c07cb87b36c6af0fceded4807055c37403321d7b177bd" }), true);
check("Mercado Pago: tolera espacios y orden inverso en el header",
  verifyMercadoPagoSignature({ ...mp, header: "v1=ab7d76bb7bc6e1d09a0c07cb87b36c6af0fceded4807055c37403321d7b177bd, ts=1704908010" }), true);
check("Mercado Pago: rechaza otro data.id",
  verifyMercadoPagoSignature({ ...mp, dataId: "999", header: "ts=1704908010,v1=ab7d76bb7bc6e1d09a0c07cb87b36c6af0fceded4807055c37403321d7b177bd" }), false);
check("Mercado Pago: data.id alfanumérico va en minúsculas",
  verifyMercadoPagoSignature({ requestId: "req-1", dataId: "ABC123DEF", secret: mp.secret,
    header: "ts=1704908010,v1=7ae5009d25753809960da650fd5e4398994efad84d69f3fcb4974f21a5a630d6" }), true);
check("Mercado Pago: rechaza header incompleto",
  verifyMercadoPagoSignature({ ...mp, header: "ts=1704908010" }), false);

// ─── Seudonimización de teléfonos en AgentRun ────────────────────────────────
// Valor esperado calculado aparte con Python (hmac + hashlib).

check("teléfono: HMAC truncado con prefijo h:",
  seudonimizarTelefono("5493510000000", "clave-de-prueba"), "h:8d119c5288b904e8");
check("teléfono: estable para el mismo número",
  seudonimizarTelefono("5493510000000", "clave-de-prueba") === seudonimizarTelefono("5493510000000", "clave-de-prueba"), true);
check("teléfono: distinto con otra clave",
  seudonimizarTelefono("5493510000000", "otra-clave") === "h:8d119c5288b904e8", false);
check("teléfono: no seudonimiza dos veces",
  seudonimizarTelefono("h:8d119c5288b904e8", "clave-de-prueba"), "h:8d119c5288b904e8");

const pasos = [
  { kind: "model", text: "hola", calls: ["consultar_reserva"] },
  { kind: "tool", name: "consultar_reserva", args: { code: "RML-1" },
    result: { code: "RML-1", guestPhone: "5493510000000", hotelPhone: "2614000000" }, ok: true },
];
const limpios = seudonimizarTelefonosEnJson(pasos, "clave-de-prueba");
check("steps: seudonimiza guestPhone anidado",
  (limpios[1] as { result: { guestPhone: string } }).result.guestPhone, "h:8d119c5288b904e8");
check("steps: conserva el teléfono público del hotel",
  (limpios[1] as { result: { hotelPhone: string } }).result.hotelPhone, "2614000000");
check("steps: no modifica el original",
  (pasos[1] as { result: { guestPhone: string } }).result.guestPhone, "5493510000000");

// ─── Reconciliación de pagos: cuándo se cancela una reserva ──────────────────
// Lo crítico: nunca cancelar una reserva cuyo pago pudo haberse aprobado.

const AHORA = new Date("2026-10-22T20:00:00Z");
const VIGENTE = new Date("2026-10-23T02:00:00Z");
const VENCIDO_RECIEN = new Date("2026-10-22T19:00:00Z");
const VENCIDO_HACE_2_DIAS = new Date("2026-10-20T19:00:00Z");

check("pago aprobado encontrado → confirma", accionTrasReconciliar("CONFIRMADA", VENCIDO_RECIEN, AHORA), "CONFIRMADA");
check("vigente sin pago → espera", accionTrasReconciliar("SIN_PAGO", VIGENTE, AHORA), "ESPERAR");
check("vencido y MP dice que no hay pago → cancela", accionTrasReconciliar("SIN_PAGO", VENCIDO_RECIEN, AHORA), "EXPIRAR");
check("vencido pero MP no respondió → NO cancela", accionTrasReconciliar("ERROR", VENCIDO_RECIEN, AHORA), "ESPERAR");
check("vencido y confirmándose en paralelo → NO cancela", accionTrasReconciliar("EN_CURSO", VENCIDO_RECIEN, AHORA), "ESPERAR");
check("vencido hace 2 días y MP sigue sin responder → cancela", accionTrasReconciliar("ERROR", VENCIDO_HACE_2_DIAS, AHORA), "EXPIRAR");
check("vencido hace 2 días pero confirmándose → NO cancela", accionTrasReconciliar("EN_CURSO", VENCIDO_HACE_2_DIAS, AHORA), "ESPERAR");
check("pago ya no pendiente → no hace nada", accionTrasReconciliar("NO_APLICA", VENCIDO_RECIEN, AHORA), "ESPERAR");

console.log(fail === 0 ? "\nTodo OK" : `\n${fail} fallo(s)`);
process.exit(fail === 0 ? 0 : 1);
