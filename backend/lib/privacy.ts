/**
 * Seudonimización de teléfonos para las trazas del agente (AgentRun).
 *
 * La traza sirve para diagnosticar y medir, no para identificar al huésped: no
 * necesita el número en claro. Se guarda un seudónimo estable (el mismo número
 * da siempre el mismo valor), así que se pueden seguir agrupando y contando
 * las ejecuciones de una misma conversación.
 *
 * Es un HMAC con secreto y no un hash simple: los teléfonos son pocos dígitos
 * y un SHA-256 sin clave se revierte probando todos los números posibles.
 *
 * La memoria conversacional NO usa esto: lee de la tabla Message, que necesita
 * el número real para responder por WhatsApp.
 */

import { createHash, createHmac } from "node:crypto";

const PREFIJO = "h:";

let avisoSinSecreto = false;

function secreto(): string | undefined {
  return process.env.PHONE_HASH_SECRET || process.env.AUTH_SECRET || undefined;
}

/** Seudónimo estable de un teléfono: "h:" + 16 caracteres hex. */
export function seudonimizarTelefono(phone: string, secret = secreto()): string {
  if (phone.startsWith(PREFIJO)) return phone;
  if (!secret) {
    if (!avisoSinSecreto) {
      avisoSinSecreto = true;
      console.warn("[privacy] sin PHONE_HASH_SECRET ni AUTH_SECRET: se usa SHA-256 sin clave");
    }
    return PREFIJO + createHash("sha256").update(phone).digest("hex").slice(0, 16);
  }
  return PREFIJO + createHmac("sha256", secret).update(phone).digest("hex").slice(0, 16);
}

/**
 * Claves de los resultados de herramientas que traen el teléfono de un huésped.
 * `hotelPhone` no está: es el teléfono público del hotel y se conserva.
 */
const CLAVES_TELEFONO = new Set(["phone", "guestPhone"]);

/** Copia de un valor JSON con los teléfonos de huéspedes seudonimizados. */
export function seudonimizarTelefonosEnJson<T>(valor: T, secret = secreto()): T {
  const recorrer = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(recorrer);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          CLAVES_TELEFONO.has(k) && typeof x === "string"
            ? seudonimizarTelefono(x, secret)
            : recorrer(x),
        ])
      );
    }
    return v;
  };
  return recorrer(valor) as T;
}
