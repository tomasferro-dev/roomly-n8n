/**
 * Smoke test de las cinco herramientas del agente, contra la base real.
 *
 *   npm run agent:tools           solo lectura (no modifica nada)
 *   npm run agent:tools -- --write  incluye el ciclo crear → modificar → cancelar
 *
 * No usa Gemini: llama a `executeTool` directamente. Sirve para separar los dos
 * lados del agente cuando algo falla — si las herramientas pasan acá, el
 * problema está en el prompt o en el loop, no en la capa de datos.
 *
 * `--write` crea una reserva DE VERDAD y pide una preferencia real a Mercado
 * Pago (no mueve plata: sólo genera el link de checkout). Al final la cancela,
 * pero la fila queda en la base como CANCELLED. Correr sólo contra desarrollo.
 */

import "dotenv/config";
import { executeTool } from "../lib/agent/tools";
import { resolveHotelId } from "../lib/agent/config";
import type { AgentContext } from "../lib/agent/types";
import { prisma } from "../lib/prisma";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

let fallos = 0;

async function probar(
  etiqueta: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
  esperar: "ok" | "error"
): Promise<unknown> {
  const inicio = Date.now();
  const { result, ok } = await executeTool(tool, args, ctx);
  const cumple = esperar === "ok" ? ok : !ok;
  if (!cumple) fallos++;

  console.log(
    `${cumple ? C.green("✓") : C.red("✗")} ${etiqueta} ${C.dim(`— ${tool} (${Date.now() - inicio}ms)`)}`
  );
  console.log(`    ${C.dim(JSON.stringify(result).slice(0, 260))}`);
  return result;
}

async function main() {
  const hotelId = await resolveHotelId();
  if (!hotelId) {
    console.error(C.red("No hay hoteles en la base."));
    process.exit(1);
  }
  const hotel = await prisma.hotel.findUniqueOrThrow({
    where: { id: hotelId },
    select: { name: true, timezone: true },
  });

  const ctx: AgentContext = {
    hotelId,
    phone: "5493510000000",
    channel: "WHATSAPP",
    timezone: hotel.timezone,
  };

  const escribir = process.argv.includes("--write");

  console.log(C.bold("\n─── Smoke test de herramientas ───────────────────"));
  console.log(`Hotel: ${hotel.name} ${C.dim(`(${hotelId})`)}`);
  console.log(C.dim(escribir ? "Modo ESCRITURA: va a crear una reserva real.\n" : "Modo lectura.\n"));

  // Fechas futuras, para no chocar con reservas existentes.
  const dia = (offset: number) =>
    new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const checkIn = dia(400);
  const checkOut = dia(403);

  // ── Lectura ────────────────────────────────────────────────────────────────
  const disp = (await probar(
    "consultar_habitaciones con fechas válidas",
    "consultar_habitaciones",
    { checkIn, checkOut },
    ctx,
    "ok"
  )) as { rooms?: { id: string; number: string; pricePerNight: number | null }[] };

  await probar(
    "consultar_habitaciones rechaza checkOut anterior",
    "consultar_habitaciones",
    { checkIn: dia(403), checkOut: dia(400) },
    ctx,
    "error"
  );

  await probar(
    "consultar_habitaciones rechaza fechas faltantes",
    "consultar_habitaciones",
    { checkIn },
    ctx,
    "error"
  );

  await probar(
    "consultar_reserva con código inexistente",
    "consultar_reserva",
    { code: "RML-0000" },
    ctx,
    "error"
  );

  const alguna = await prisma.reservation.findFirst({
    orderBy: { createdAt: "desc" },
    select: { code: true },
  });
  if (alguna) {
    await probar(
      `consultar_reserva con un código real (${alguna.code})`,
      "consultar_reserva",
      { code: alguna.code.toLowerCase() }, // en minúscula: el handler normaliza
      ctx,
      "ok"
    );
  }

  await probar(
    "modificar_reserva sin campos a cambiar",
    "modificar_reserva",
    { id: "cualquiera" },
    ctx,
    "error"
  );

  await probar(
    "herramienta inexistente",
    "no_existe",
    {},
    ctx,
    "error"
  );

  // ── Escritura ──────────────────────────────────────────────────────────────
  if (escribir) {
    const room = disp.rooms?.find((r) => r.pricePerNight !== null) ?? disp.rooms?.[0];
    if (!room) {
      console.log(C.yellow("\n(sin habitaciones disponibles — se omite el ciclo de escritura)"));
    } else {
      console.log(C.bold("\n─── Ciclo crear → modificar → cancelar ───────────"));

      const creada = (await probar(
        `crear_reserva en hab. ${room.number} con seña`,
        "crear_reserva",
        {
          roomId: room.id,
          guestName: "Prueba Agente",
          checkIn,
          checkOut,
          numGuests: 2,
          paymentType: "DEPOSIT",
        },
        ctx,
        "ok"
      )) as { code?: string; paymentUrl?: string };

      if (creada.code) {
        const detalle = (await probar(
          `consultar_reserva ${creada.code}`,
          "consultar_reserva",
          { code: creada.code },
          ctx,
          "ok"
        )) as { id?: string };

        if (detalle.id) {
          await probar(
            "modificar_reserva cambia numGuests",
            "modificar_reserva",
            { id: detalle.id, numGuests: 3 },
            ctx,
            "ok"
          );
          await probar(
            "cancelar_reserva",
            "cancelar_reserva",
            { id: detalle.id },
            ctx,
            "ok"
          );
          await probar(
            "cancelar_reserva otra vez falla",
            "cancelar_reserva",
            { id: detalle.id },
            ctx,
            "error"
          );
        }
      }
    }
  }

  console.log(
    fallos === 0 ? C.green(C.bold("\nTodo OK\n")) : C.red(C.bold(`\n${fallos} fallo(s)\n`))
  );
  process.exit(fallos === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error(C.red("\nError fatal:"), err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
