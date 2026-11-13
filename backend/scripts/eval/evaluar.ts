/**
 * Corre el corpus contra el agente (sección 5 del protocolo).
 *
 *   npx tsx scripts/eval/evaluar.ts --modelo gemini-3.1-flash-lite --corrida 1 [--pausa 4500] [--limite 5]
 *
 * Cada mensaje se corre con historial vacío y la fecha de referencia fija.
 * Las herramientas que escriben se reemplazan por dobles; consultar_habitaciones
 * es la real y lee la base de DATABASE_URL, que para la evaluación tiene que
 * apuntar a la branch de Neon (no a producción). Sin modelo de respaldo.
 *
 * Escribe docs/evaluacion/datos/corridas/<modelo>-c<corrida>.jsonl, una línea
 * por mensaje. Si se corta, al volver a correrlo retoma: saltea los mensajes
 * que ya terminaron bien y reintenta los que fallaron.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { runAgent } from "../../lib/agent/run";
import { executeTool } from "../../lib/agent/tools";
import { resolveHotelId } from "../../lib/agent/config";
import { prisma } from "../../lib/prisma";
import { precioDeEstadia, montoAPagar } from "../../services/pricing.service";
import type { AgentContext } from "../../lib/agent/types";
import { CORPUS, CORRIDAS, FECHA_REFERENCIA, leerJsonl, type Ejecucion, type Mensaje } from "./comun";

function arg(nombre: string, porDefecto?: string) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : porDefecto;
}
const modelo = arg("modelo");
const corrida = Number(arg("corrida"));
const pausa = Number(arg("pausa", "4500"));
const limite = Number(arg("limite", "0"));
if (!modelo || !Number.isInteger(corrida) || corrida < 1) {
  console.error("Uso: evaluar.ts --modelo <modelo> --corrida <n> [--pausa ms] [--limite n]");
  process.exit(1);
}
if (/neon\.tech/.test(process.env.DATABASE_URL ?? "") && !process.env.EVAL_BRANCH_OK) {
  console.error("DATABASE_URL apunta a Neon: confirmá que es la branch de evaluación con EVAL_BRANCH_OK=1.");
  process.exit(1);
}

/** Reserva que devuelve consultar_reserva para cualquier código (TARJETAS.md). */
const RESERVA_FIJA = {
  id: "eval-reserva",
  room: "101",
  floor: 1,
  status: "CONFIRMED",
  checkIn: "2026-12-10",
  checkOut: "2026-12-12",
  guestName: "Huésped de prueba",
  numGuests: 2,
  totalPrice: 30000,
  pricePerNight: 15000,
};

/**
 * Dobles de las herramientas que escriben. Devuelven lo mismo que devolverían
 * las reales en un primer mensaje, sin tocar la base ni Mercado Pago.
 */
function crearEjecutor(registro: Ejecucion["herramientas"]): typeof executeTool {
  return async (name, args, ctx) => {
    let salida: { result: unknown; ok: boolean };
    switch (name) {
      case "consultar_habitaciones":
        salida = await executeTool(name, args, ctx);
        break;
      case "proponer_reserva": {
        const room = await prisma.room.findFirst({
          where: { hotelId: ctx.hotelId, OR: [{ id: String(args.roomId) }, { number: String(args.roomId) }] },
          select: { id: true, number: true },
        });
        if (!room) { salida = { result: { error: "Esa habitación no existe." }, ok: false }; break; }
        const { pricePerNight, nights, totalPrice } = await precioDeEstadia(room.id, String(args.checkIn), String(args.checkOut));
        salida = {
          ok: true,
          result: {
            propuesta: { ...args, room: room.number, nights, pricePerNight, totalPrice,
              payAmount: montoAPagar(totalPrice, String(args.paymentType)) },
            siguientePaso: "Mostrale este resumen al huésped y preguntale si lo confirma. NO llames a crear_reserva en este mismo turno.",
          },
        };
        break;
      }
      case "crear_reserva": {
        // En un primer mensaje la real siempre rechaza: no hay propuesta de un turno anterior.
        const propuso = registro.some((h) => h.name === "proponer_reserva");
        salida = {
          ok: false,
          result: {
            error: propuso
              ? "El huésped todavía no vio el resumen. Mostráselo y esperá su confirmación antes de crear la reserva."
              : "Antes de crear la reserva llamá a proponer_reserva, mostrale el resumen al huésped y esperá que lo confirme.",
          },
        };
        break;
      }
      case "consultar_reserva":
        salida = { ok: true, result: { ...RESERVA_FIJA, code: String(args.code ?? "").toUpperCase() } };
        break;
      case "modificar_reserva":
        salida = { ok: true, result: { ...RESERVA_FIJA, ...args, id: RESERVA_FIJA.id } };
        break;
      case "cancelar_reserva":
        salida = { ok: true, result: { id: RESERVA_FIJA.id, status: "CANCELLED" } };
        break;
      default:
        salida = await executeTool(name, args, ctx);
    }
    registro.push({ name, args, ok: salida.ok, result: salida.result });
    return salida;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const corpus: Mensaje[] = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
  const hotelId = await resolveHotelId();
  if (!hotelId) throw new Error("No hay hotel en la base.");
  const hotel = await prisma.hotel.findUniqueOrThrow({ where: { id: hotelId }, select: { timezone: true } });

  fs.mkdirSync(CORRIDAS, { recursive: true });
  const salida = path.join(CORRIDAS, `${modelo}-c${corrida}.jsonl`);
  const hechos = new Set(leerJsonl<Ejecucion>(salida).filter((e) => e.status !== "FAILED").map((e) => e.id));
  const pendientes = corpus.filter((m) => !hechos.has(m.id)).slice(0, limite || undefined);
  console.log(`${modelo} · corrida ${corrida} · ${hechos.size} hechos · ${pendientes.length} por correr`);

  for (const [i, m] of pendientes.entries()) {
    const herramientas: Ejecucion["herramientas"] = [];
    const ctx: AgentContext = {
      hotelId,
      // Un teléfono distinto por mensaje: ninguna ejecución ve el estado de otra.
      phone: `54900000${m.id.slice(1).padStart(5, "0")}`,
      channel: "WHATSAPP",
      timezone: hotel.timezone,
    };
    const r = await runAgent(m.texto, ctx, {
      history: [],
      now: FECHA_REFERENCIA,
      model: modelo,
      sinRespaldo: true,
      ejecutor: crearEjecutor(herramientas),
    });
    const e: Ejecucion = {
      id: m.id, modelo: modelo!, corrida, texto: m.texto, respuesta: r.text, herramientas,
      status: r.status, error: r.error, durationMs: r.durationMs,
      promptTokens: r.promptTokens, outputTokens: r.outputTokens, at: new Date().toISOString(),
    };
    fs.appendFileSync(salida, JSON.stringify(e) + "\n");
    console.log(`${i + 1}/${pendientes.length} ${m.id} ${r.status} ${r.durationMs} ms · ${herramientas.map((h) => h.name).join(", ") || "sin herramientas"}`);
    await sleep(pausa);
  }
  const todas = leerJsonl<Ejecucion>(salida);
  const ultimas = new Map(todas.map((e) => [e.id, e]));
  const fallidas = [...ultimas.values()].filter((e) => e.status === "FAILED").length;
  console.log(`Listo: ${ultimas.size}/${corpus.length} mensajes, ${fallidas} fallidos (volver a correr para reintentarlos).`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
