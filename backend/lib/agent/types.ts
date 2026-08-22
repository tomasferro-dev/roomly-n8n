/**
 * Tipos compartidos del agente.
 *
 * El agente reemplaza al nodo "AI Agent – Roomly" del workflow de n8n
 * (Roomly v14). Cada ejecución produce un AgentRun con la traza completa,
 * que es el equivalente propio del historial de ejecuciones de n8n.
 */

import type { Channel } from "@prisma/client";

/** Contexto de una ejecución: quién escribe, a qué hotel y por qué canal. */
export type AgentContext = {
  hotelId: string;
  phone: string;
  channel: Channel;
  /** Zona horaria del hotel; define qué día es "HOY" para el agente. */
  timezone: string;
};

/**
 * Un paso de la traza. Se guarda en AgentRun.steps como JSON.
 * Los pasos `tool` son el equivalente a ver el input/output de un nodo
 * de herramienta en el visor de ejecuciones de n8n.
 */
export type AgentStep =
  | {
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      /** Resultado serializado que se le devolvió al modelo. */
      result: unknown;
      ok: boolean;
      durationMs: number;
    }
  | {
      kind: "model";
      /** Texto que emitió el modelo en esta iteración, si emitió alguno. */
      text: string | null;
      /** Nombres de las herramientas que pidió llamar. */
      calls: string[];
      durationMs: number;
    };

export type AgentResult = {
  /** Texto a enviar al huésped. `null` cuando el modelo no produjo respuesta. */
  text: string | null;
  status: "OK" | "FAILED" | "EMPTY";
  error?: string;
  steps: AgentStep[];
  iterations: number;
  model: string;
  promptTokens?: number;
  outputTokens?: number;
  durationMs: number;
};

/** Handler de una herramienta. Devuelve lo que se le pasa al modelo como resultado. */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: AgentContext
) => Promise<unknown>;
