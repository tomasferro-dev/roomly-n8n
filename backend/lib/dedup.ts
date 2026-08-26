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

import { prisma } from "./prisma";

/**
 * "SWEEP" no es un webhook: lo usa lib/sweep.ts para que un solo proceso corra
 * el barrido por ventana de tiempo, apoyandose en el mismo indice unico.
 */
export type Provider = "WHATSAPP" | "MERCADOPAGO" | "SWEEP";

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
    // `createMany` con skipDuplicates en vez de `create` + catch del P2002.
    // Los dos son atómicos, pero el segundo hace que Prisma escriba un
    // `prisma:error` por cada colisión — y las colisiones acá son el
    // funcionamiento NORMAL, no una falla. En producción eso llenaba los logs
    // de errores falsos que tapan los de verdad.
    //
    // Devuelve cuántas filas insertó: 1 si ganamos, 0 si otro llegó primero.
    const { count } = await prisma.processedEvent.createMany({
      data: [{ provider, externalId }],
      skipDuplicates: true,
    });
    return count === 1;
  } catch (err) {
    // Cualquier error real (base caída, por ejemplo) no debería hacernos
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
