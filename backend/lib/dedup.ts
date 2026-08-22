/**
 * Deduplicación de webhooks entrantes.
 *
 * Meta reintenta la entrega si no recibe un 200 dentro de ~20 segundos, y a
 * veces entrega el mismo mensaje más de una vez igual. Sin protección, el bot
 * responde dos veces al mismo mensaje y —lo grave— el agente puede llegar a
 * crear dos reservas.
 *
 * La atomicidad la da el índice único de `ProcessedEvent`: se intenta insertar
 * ANTES de procesar y, si el insert viola el único, es que otra invocación ya
 * tomó ese evento. En serverless esto importa más que en un servidor común,
 * porque dos entregas simultáneas pueden caer en dos instancias distintas y un
 * chequeo "¿existe? entonces insertá" tendría una ventana de carrera entre las
 * dos consultas.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export type Provider = "WHATSAPP" | "MERCADOPAGO";

/**
 * Intenta tomar un evento para procesarlo.
 *
 * @returns `true` si es la primera vez que se ve y hay que procesarlo,
 *          `false` si ya fue tomado por otra entrega.
 */
export async function reclamarEvento(
  provider: Provider,
  externalId: string
): Promise<boolean> {
  if (!externalId) {
    // Sin id no se puede deduplicar. Preferimos procesar y arriesgar un
    // duplicado antes que descartar un mensaje real de un huésped.
    return true;
  }

  try {
    await prisma.processedEvent.create({ data: { provider, externalId } });
    return true;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return false; // ya lo tomó otra entrega
    }
    // Cualquier otro error (base caída, por ejemplo) no debería hacernos
    // perder el mensaje: seguimos adelante.
    console.warn("[dedup] no se pudo reclamar el evento:", err);
    return true;
  }
}

/**
 * Borra los eventos viejos. La tabla sólo sirve para detectar reintentos, que
 * ocurren en cuestión de minutos; guardar más que unos días es acumular por
 * acumular. Lo llama el cron de mantenimiento.
 */
export async function limpiarEventosViejos(dias = 7): Promise<number> {
  const corte = new Date(Date.now() - dias * 86400000);
  const { count } = await prisma.processedEvent.deleteMany({
    where: { receivedAt: { lt: corte } },
  });
  return count;
}
