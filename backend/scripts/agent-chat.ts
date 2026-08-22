/**
 * Banco de pruebas del agente — conversar con el bot sin WhatsApp ni n8n.
 *
 *   npx tsx scripts/agent-chat.ts                    modo interactivo
 *   npx tsx scripts/agent-chat.ts --guion reserva    corre un guión predefinido
 *   npx tsx scripts/agent-chat.ts --guion todos      corre todos los guiones
 *
 * Opciones:
 *   --telefono 549351...   teléfono a simular (default: 5493510000000)
 *   --hotel <id>           hotel a usar (default: HOTEL_ID o el primero de la DB)
 *   --pasos                muestra cada herramienta llamada con sus argumentos
 *
 * Esto es lo que permite verificar que el agente propio se comporta igual que
 * el de n8n ANTES de reapuntar el webhook de Meta. La conversación vive en
 * memoria: no escribe en la tabla Message, así que se puede repetir cuantas
 * veces haga falta sin ensuciar el historial real.
 *
 * OJO: las herramientas sí tocan la base — crear_reserva crea una reserva de
 * verdad y genera una preferencia real de Mercado Pago. Correlo contra una base
 * de desarrollo, no contra producción.
 */

import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Content } from "@google/genai";
import { runAgent } from "../lib/agent/run";
import { resolveHotelId } from "../lib/agent/config";
import type { AgentContext, AgentStep } from "../lib/agent/types";
import { prisma } from "../lib/prisma";

// ─── Guiones ──────────────────────────────────────────────────────────────────

const GUIONES: Record<string, string[]> = {
  reserva: [
    "hola, quiero reservar una habitación",
    "para el 15 al 18 de septiembre, somos 2 personas",
    "mi nombre es Tomás Ferro",
    "la más barata",
    "la seña",
  ],
  consulta: ["hola", "quiero consultar mi reserva RML-1234"],
  fuera_de_tema: ["hola, tenés delivery de pizza?"],
  fechas_invalidas: [
    "quiero reservar del 20 de septiembre al 18 de septiembre",
  ],
  cancelacion: [
    "quiero cancelar la reserva RML-1234",
    "sí, confirmo que la quiero cancelar",
  ],
};

// ─── CLI ──────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function mostrarPasos(steps: AgentStep[]) {
  for (const step of steps) {
    if (step.kind === "tool") {
      const icono = step.ok ? C.green("✓") : C.red("✗");
      console.log(
        `  ${icono} ${C.yellow(step.name)}(${C.dim(JSON.stringify(step.args))}) ${C.dim(`${step.durationMs}ms`)}`
      );
      console.log(`    ${C.dim(JSON.stringify(step.result).slice(0, 300))}`);
    } else if (step.calls.length > 0) {
      console.log(`  ${C.dim(`→ modelo pide: ${step.calls.join(", ")} (${step.durationMs}ms)`)}`);
    }
  }
}

async function turno(
  mensaje: string,
  ctx: AgentContext,
  history: Content[],
  verPasos: boolean
): Promise<void> {
  console.log(`\n${C.cyan("Huésped:")} ${mensaje}`);

  const result = await runAgent(mensaje, ctx, { history });

  if (verPasos) mostrarPasos(result.steps);

  if (result.text) {
    console.log(`${C.green("Roomly:")}  ${result.text.replace(/\n/g, "\n         ")}`);
  } else {
    console.log(`${C.red("Roomly:")}  (sin respuesta — ${result.status}${result.error ? `: ${result.error}` : ""})`);
  }

  const tokens = `${result.promptTokens ?? 0}→${result.outputTokens ?? 0} tok`;
  console.log(
    C.dim(`         [${result.status} · ${result.iterations} iter · ${tokens} · ${result.durationMs}ms]`)
  );

  // Mantener el hilo en memoria para el turno siguiente.
  history.push({ role: "user", parts: [{ text: mensaje }] });
  if (result.text) history.push({ role: "model", parts: [{ text: result.text }] });
}

async function main() {
  const hotelId = arg("hotel") ?? (await resolveHotelId());
  if (!hotelId) {
    console.error(C.red("No hay ningún hotel en la base. Corré primero: npm run db:seed"));
    process.exit(1);
  }

  const hotel = await prisma.hotel.findUnique({
    where: { id: hotelId },
    select: { name: true, timezone: true },
  });
  if (!hotel) {
    console.error(C.red(`No existe el hotel ${hotelId}.`));
    process.exit(1);
  }

  const ctx: AgentContext = {
    hotelId,
    phone: arg("telefono") ?? "5493510000000",
    channel: "WHATSAPP",
    timezone: hotel.timezone,
  };

  const verPasos = flag("pasos");

  console.log(C.bold("\n─── Banco de pruebas del agente ──────────────────"));
  console.log(`Hotel:    ${hotel.name} ${C.dim(`(${hotelId})`)}`);
  console.log(`Teléfono: ${ctx.phone}`);
  console.log(`Zona:     ${ctx.timezone}`);
  console.log(C.dim("La conversación NO se guarda en la tabla Message."));
  console.log(C.dim("Las reservas que se creen SÍ son reales.\n"));

  const guion = arg("guion");

  if (guion) {
    const nombres = guion === "todos" ? Object.keys(GUIONES) : [guion];
    for (const nombre of nombres) {
      const mensajes = GUIONES[nombre];
      if (!mensajes) {
        console.error(C.red(`No existe el guión "${nombre}". Disponibles: ${Object.keys(GUIONES).join(", ")}, todos`));
        process.exit(1);
      }
      console.log(C.bold(`\n━━━ Guión: ${nombre} ${"━".repeat(Math.max(0, 40 - nombre.length))}`));
      const history: Content[] = [];
      for (const mensaje of mensajes) {
        await turno(mensaje, ctx, history, verPasos);
      }
    }
    console.log();
    return;
  }

  // Modo interactivo.
  console.log(C.dim("Escribí un mensaje. Enter vacío o Ctrl+C para salir.\n"));
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const history: Content[] = [];

  try {
    for (;;) {
      const mensaje = (await rl.question(C.cyan("> "))).trim();
      if (!mensaje) break;
      await turno(mensaje, ctx, history, verPasos);
    }
  } finally {
    rl.close();
  }
}

main()
  .catch((err) => {
    console.error(C.red("\nError fatal:"), err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // Salida explícita: importar las herramientas arrastra `lib/queue.ts`, que
    // abre una conexión de BullMQ a Redis y mantiene vivo el event loop. Sin
    // esto el script termina de imprimir y se queda colgado. Desaparece en la
    // Fase 3, cuando se saca BullMQ.
    process.exit(process.exitCode ?? 0);
  });
