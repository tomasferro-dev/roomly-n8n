/**
 * Conservación de datos personales.
 *
 * Las conversaciones (Message) y las trazas del agente (AgentRun) guardan el
 * texto que escribe el huésped. Se conservan un plazo fijo, el que necesita el
 * hotel para gestionar la estadía y revisar reclamos, y después se borran. El
 * plazo sale de RETENCION_DIAS; por defecto, 180 días.
 *
 * Además, las trazas anteriores al 23/10/2026 se guardaron con el teléfono en
 * claro, porque la seudonimización se agregó ese día. Se seudonimizan acá, en
 * el mismo proceso que corre en producción, para que el seudónimo use el mismo
 * secreto que las trazas nuevas.
 */

import { prisma } from "./prisma";
import { seudonimizarTelefono, seudonimizarTelefonosEnJson } from "./privacy";

export const RETENCION_DIAS_POR_DEFECTO = 180;

export function diasDeRetencion(valor = process.env.RETENCION_DIAS): number {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : RETENCION_DIAS_POR_DEFECTO;
}

/** Instante antes del cual los datos ya cumplieron el plazo de conservación. */
export function fechaDeCorte(dias: number, ahora = new Date()): Date {
  return new Date(ahora.getTime() - dias * 86400000);
}

/** Borra conversaciones y trazas más viejas que el plazo. La llama el cron diario. */
export async function purgarDatosVencidos(dias = diasDeRetencion()) {
  const corte = fechaDeCorte(dias);
  const [mensajes, trazas] = await prisma.$transaction([
    prisma.message.deleteMany({ where: { createdAt: { lt: corte } } }),
    prisma.agentRun.deleteMany({ where: { createdAt: { lt: corte } } }),
  ]);
  return { mensajes: mensajes.count, trazas: trazas.count };
}

/**
 * Seudonimiza las trazas que todavía tienen el teléfono en claro. Procesa por
 * tandas para no exceder el tiempo de la función; cuando no queda ninguna, no
 * hace nada. Nunca lanza.
 */
export async function seudonimizarTrazasViejas(tanda = 200): Promise<number> {
  try {
    const pendientes = await prisma.agentRun.findMany({
      where: { NOT: { phone: { startsWith: "h:" } } },
      select: { id: true, phone: true, steps: true },
      take: tanda,
    });
    for (const r of pendientes) {
      await prisma.agentRun.update({
        where: { id: r.id },
        data: {
          phone: seudonimizarTelefono(r.phone),
          steps: seudonimizarTelefonosEnJson(r.steps) as object,
        },
      });
    }
    return pendientes.length;
  } catch (err) {
    console.warn("[retencion] no se pudieron seudonimizar las trazas viejas:", err);
    return 0;
  }
}
