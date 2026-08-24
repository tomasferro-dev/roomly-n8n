/**
 * Hook de arranque de Next.js.
 *
 * Antes acá se levantaba el worker de BullMQ. Se eliminó junto con la cola:
 * en Vercel las funciones se congelan entre invocaciones, así que un worker
 * de larga vida no procesa nada. Lo que la cola hacía ahora está repartido en
 * dos lugares: las tareas cortas corren inline donde se disparan, y lo
 * diferido (expiración de pagos a las 24 h) lo barre el cron
 * /api/cron/expire-payments.
 *
 * El archivo queda vacío a propósito: Next.js lo espera si existe la
 * convención, y deja el lugar listo para instrumentación real (tracing,
 * métricas) más adelante.
 */
export async function register() {}
