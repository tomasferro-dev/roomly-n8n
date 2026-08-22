/**
 * Memoria conversacional del agente.
 *
 * Reemplaza al nodo `memoryBufferWindow` de n8n, que guardaba los últimos
 * turnos EN RAM del contenedor. Ese diseño tenía un problema real: si n8n se
 * reiniciaba — deploy, OOM, spin-down del plan free — todos los huéspedes
 * perdían el hilo de la conversación en el medio, justo cuando estaban dando
 * fechas o eligiendo habitación.
 *
 * Acá la memoria sale de la tabla `Message`, donde el turno ya se venía
 * guardando igual (lo hacía el nodo "Logging de interacción"). Es la misma
 * ventana de contexto, pero persistente y sobreviviendo a cualquier reinicio.
 */

import type { Content } from "@google/genai";
import { prisma } from "@/lib/prisma";

/**
 * Últimos turnos de conversación de un teléfono, en formato Gemini.
 *
 * @param phone   Teléfono del huésped, tal como llega de WhatsApp.
 * @param turns   Cantidad de intercambios a recordar. Equivale al
 *                `contextWindowLength` de n8n, que contaba interacciones
 *                (usuario + bot), no mensajes sueltos.
 */
export async function loadHistory(phone: string, turns = 10): Promise<Content[]> {
  const messages = await prisma.message.findMany({
    where: { phone },
    orderBy: { createdAt: "desc" },
    take: turns * 2,
    select: { direction: true, content: true },
  });

  return messages
    .reverse()
    .map((m) => ({
      role: m.direction === "INBOUND" ? "user" : "model",
      parts: [{ text: m.content }],
    }))
    .filter((c) => c.parts[0].text.trim() !== "");
}

/**
 * Gemini rechaza un historial que arranque con un turno del modelo: la
 * conversación tiene que abrir del lado del usuario. Puede pasar si el bot
 * mandó el primer mensaje (por ejemplo la confirmación de un pago acreditado),
 * así que se descartan los turnos del modelo que queden al principio.
 */
export function normalizeHistory(history: Content[]): Content[] {
  let start = 0;
  while (start < history.length && history[start].role !== "user") start++;
  return history.slice(start);
}
