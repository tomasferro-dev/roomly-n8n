/**
 * Configuración del bot, editable sin redeploy.
 *
 * Esto es lo que reemplaza al editor visual de n8n para el caso de uso que
 * realmente le dabas: cambiar el system prompt y ver qué pasa. La fila
 * `BotConfig` del hotel gana sobre los valores del código; si no existe, se usa
 * el prompt versionado en `prompt.ts`, que es la fuente de verdad por defecto.
 */

import { prisma } from "@/lib/prisma";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt";

export type ResolvedBotConfig = {
  systemPrompt: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  memoryWindow: number;
  enabled: boolean;
  timezone: string;
};

/** Mismos valores que tenía el nodo "Gemini Flash" del workflow. */
export const BOT_DEFAULTS = {
  model: "gemini-3.1-flash-lite",
  temperature: 0.1,
  maxOutputTokens: 512,
  memoryWindow: 10,
} as const;

const FALLBACK_TIMEZONE = "America/Argentina/Buenos_Aires";

export async function loadBotConfig(hotelId: string): Promise<ResolvedBotConfig> {
  const [config, hotel] = await Promise.all([
    prisma.botConfig.findUnique({ where: { hotelId } }),
    prisma.hotel.findUnique({ where: { id: hotelId }, select: { timezone: true } }),
  ]);

  return {
    systemPrompt: config?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    model: config?.model ?? BOT_DEFAULTS.model,
    temperature: config?.temperature ?? BOT_DEFAULTS.temperature,
    maxOutputTokens: config?.maxOutputTokens ?? BOT_DEFAULTS.maxOutputTokens,
    memoryWindow: config?.memoryWindow ?? BOT_DEFAULTS.memoryWindow,
    enabled: config?.enabled ?? true,
    timezone: hotel?.timezone ?? FALLBACK_TIMEZONE,
  };
}

/**
 * Hotel por defecto para el caso single-tenant.
 *
 * n8n resolvía esto con la env var HOTEL_ID, que había que copiar a mano en dos
 * archivos `.env` y volver a pegar después de cada seed. Acá se sigue
 * respetando HOTEL_ID si está seteada, pero si falta se cae al único hotel de
 * la base — que es el caso real hoy — en vez de romper.
 */
export async function resolveHotelId(): Promise<string | null> {
  const fromEnv = process.env.HOTEL_ID?.trim();
  if (fromEnv) return fromEnv;

  const hotel = await prisma.hotel.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return hotel?.id ?? null;
}
