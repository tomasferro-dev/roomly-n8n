/**
 * Persistencia de la traza de ejecución.
 *
 * Es el reemplazo propio del historial de ejecuciones de n8n. Guarda por cada
 * mensaje entrante: qué llegó, qué herramientas se llamaron con qué argumentos
 * y qué devolvieron, qué contestó el bot, cuántos tokens y cuánto tardó.
 *
 * Ventaja sobre el visor de n8n: es una tabla, así que se puede preguntar en
 * SQL "¿cuántas conversaciones terminaron sin reserva?" o "¿qué herramienta
 * falla más?", cosas que allá había que mirar ejecución por ejecución.
 *
 * Nunca lanza: perder la traza no puede tumbar una respuesta al huésped.
 */

import type { Channel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext, AgentResult } from "./types";

export async function saveRun(
  ctx: AgentContext,
  inboundText: string,
  result: AgentResult
): Promise<void> {
  try {
    await prisma.agentRun.create({
      data: {
        hotelId: ctx.hotelId,
        phone: ctx.phone,
        channel: ctx.channel as Channel,
        inboundText,
        outboundText: result.text,
        status: result.status,
        error: result.error,
        steps: result.steps as unknown as Prisma.InputJsonValue,
        model: result.model,
        promptTokens: result.promptTokens,
        outputTokens: result.outputTokens,
        iterations: result.iterations,
        durationMs: result.durationMs,
      },
    });
  } catch (err) {
    console.warn("[agent:trace] no se pudo guardar la traza:", err);
  }
}
