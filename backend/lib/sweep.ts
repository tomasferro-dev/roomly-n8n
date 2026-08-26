/**
 * Barrido oportunista.
 *
 * El plan Hobby de Vercel sólo admite crons diarios. Con un único barrido al
 * día, una reserva impaga puede quedar bloqueando la habitación hasta 24 horas
 * después de su vencimiento — el promedio es medio día. Con siete habitaciones,
 * eso es una habitación sin vender.
 *
 * La solución no cuesta nada: aprovechar el tráfico que ya existe. Cada mensaje
 * de WhatsApp dispara un barrido, con un límite de uno cada 15 minutos. Corre
 * dentro de `after()`, o sea después de haberle respondido al huésped, así que
 * no le agrega ni un milisegundo a la conversación.
 *
 * El razonamiento de fondo: una habitación bloqueada de más sólo importa cuando
 * alguien está tratando de reservar. Justo cuando hay tráfico. Y si no hay
 * nadie usando el bot, el cron diario alcanza y sobra.
 *
 * El cron diario NO se elimina: es la red que cubre los días sin tráfico.
 */

import { prisma } from "./prisma";
import { reclamarEvento } from "./dedup";
import { expirePendingPayments } from "@/services/payment.service";

/** Cada cuánto, como mucho, se permite un barrido oportunista. */
const VENTANA_MIN = 15;

/**
 * La exclusión mutua se apoya en el mismo índice único que la deduplicación de
 * webhooks: se calcula el bucket de 15 minutos al que pertenece este instante y
 * se intenta reclamarlo. Sólo una invocación gana el insert; las demás salen.
 *
 * Sirve igual en serverless, donde no hay memoria compartida entre instancias y
 * un contador en proceso no serviría de nada.
 */
function bucketActual(ahora = new Date()): string {
  const ms = VENTANA_MIN * 60 * 1000;
  return new Date(Math.floor(ahora.getTime() / ms) * ms).toISOString();
}

/**
 * Corre el barrido si nadie lo corrió en esta ventana. Nunca lanza: es trabajo
 * de mantenimiento y no puede afectar la conversación que lo disparó.
 */
export async function barrerSiCorresponde(): Promise<void> {
  try {
    const meToca = await reclamarEvento("SWEEP", bucketActual());
    if (!meToca) return;

    const { vencidas, huerfanas } = await expirePendingPayments();
    if (vencidas > 0 || huerfanas > 0) {
      console.log(
        `[sweep] oportunista: ${vencidas} vencidas, ${huerfanas} huérfanas`
      );
    }
  } catch (err) {
    console.warn("[sweep] falló el barrido oportunista:", err);
  }
}

/**
 * Purga los marcadores de barrido viejos. Se llama desde el cron diario junto
 * con la limpieza de eventos de webhook.
 */
export async function limpiarMarcasDeBarrido(dias = 2): Promise<number> {
  const corte = new Date(Date.now() - dias * 86400000);
  const { count } = await prisma.processedEvent.deleteMany({
    where: { provider: "SWEEP", receivedAt: { lt: corte } },
  });
  return count;
}
