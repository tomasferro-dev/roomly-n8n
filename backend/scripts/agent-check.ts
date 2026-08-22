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

console.log(fail === 0 ? "\nTodo OK" : `\n${fail} fallo(s)`);
process.exit(fail === 0 ? 0 : 1);
