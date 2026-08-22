/**
 * El loop del agente.
 *
 * Equivale al nodo "AI Agent – Roomly" del workflow de n8n: recibe el mensaje
 * del huésped, le da al modelo el historial y las cinco herramientas, y itera
 * llamada-de-herramienta / resultado hasta que el modelo produce texto.
 *
 * Lo que n8n daba gratis y acá está explícito:
 *   · el tope de iteraciones (n8n lo llamaba "Max Iterations")
 *   · el reintento ante fallos transitorios (`retryOnFail: true` en el nodo)
 *   · la traza de cada paso, que allá se veía en el visor de ejecuciones y acá
 *     se devuelve en `steps` para guardarse en la tabla AgentRun
 */

import {
  GoogleGenAI,
  createPartFromFunctionResponse,
  createUserContent,
  type Content,
} from "@google/genai";
import { functionDeclarations, executeTool } from "./tools";
import { buildSystemPrompt } from "./prompt";
import { loadHistory, normalizeHistory } from "./memory";
import { loadBotConfig } from "./config";
import type { AgentContext, AgentResult, AgentStep } from "./types";

/**
 * Tope de vueltas del loop. Una reserva completa usa como mucho dos
 * (consultar_habitaciones → crear_reserva); seis deja margen para reintentos
 * del modelo sin arriesgar un loop infinito contra la API.
 */
const MAX_ITERATIONS = 6;

/** Reintentos ante errores transitorios de la API de Gemini. */
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 600;

/**
 * Tope de espera cuando Gemini nos dice cuánto falta para reintentar.
 *
 * El tier gratuito permite 15 requests por minuto y, al pasarse, responde 429
 * con un `retryDelay` que suele ser de 30-40 s. Reintentar a los 600 ms como
 * hace el backoff exponencial es inútil: vuelve a rebotar y quema el intento.
 * Pero tampoco tiene sentido esperar un minuto — del otro lado hay un huésped
 * mirando WhatsApp. Si la espera pedida supera este tope, fallamos derecho y
 * el huésped recibe el mensaje de disculpa.
 */
const RETRY_MAX_WAIT_MS = 20_000;

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY no está configurada.");
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

/** 429 y 5xx son transitorios; el resto (401, 400) no mejora reintentando. */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  const message = err instanceof Error ? err.message : String(err);
  return /429|50\d|timeout|ECONNRESET|fetch failed|overloaded|UNAVAILABLE/i.test(message);
}

/**
 * Espera que pide la propia API, en ms, o `null` si no la indicó.
 *
 * Gemini adjunta un `RetryInfo` con `retryDelay: "40s"` dentro de `details`.
 * El SDK entrega ese cuerpo como texto en `error.message`, así que hay que
 * parsearlo. Respetarlo evita reintentar justo cuando sabemos que va a fallar.
 */
function retryAfterMs(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Concatena las partes de texto de un turno, ignorando las de functionCall. */
function textoDePartes(parts: { text?: string }[] | undefined): string | null {
  const texto = (parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  return texto === "" ? null : texto;
}

export type RunAgentOptions = {
  /** Historial precargado. Si se omite, se lee de la tabla Message. */
  history?: Content[];
  /** Fecha a usar como "HOY". Sólo para pruebas reproducibles. */
  now?: Date;
};

export async function runAgent(
  message: string,
  ctx: AgentContext,
  options: RunAgentOptions = {}
): Promise<AgentResult> {
  const startedAt = Date.now();
  const steps: AgentStep[] = [];
  const config = await loadBotConfig(ctx.hotelId);

  const base = {
    steps,
    iterations: 0,
    model: config.model,
    durationMs: 0,
  };

  if (!config.enabled) {
    return { ...base, text: null, status: "EMPTY", durationMs: Date.now() - startedAt };
  }

  const systemInstruction = buildSystemPrompt(config.systemPrompt, {
    timezone: config.timezone,
    phone: ctx.phone,
    at: options.now,
  });

  const history =
    options.history ?? (await loadHistory(ctx.phone, config.memoryWindow));

  const contents: Content[] = [
    ...normalizeHistory(history),
    createUserContent(message),
  ];

  let promptTokens = 0;
  let outputTokens = 0;
  let iterations = 0;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      iterations = i + 1;
      const turnStart = Date.now();

      const response = await generateWithRetry({
        model: config.model,
        contents,
        config: {
          systemInstruction,
          temperature: config.temperature,
          maxOutputTokens: config.maxOutputTokens,
          tools: [{ functionDeclarations }],
        },
      });

      promptTokens += response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;

      const calls = response.functionCalls ?? [];
      // Cuando la respuesta trae functionCall, el getter `.text` del SDK emite
      // un warning por consola en cada turno. Leemos las partes a mano.
      const text =
        calls.length === 0
          ? response.text?.trim() || null
          : textoDePartes(response.candidates?.[0]?.content?.parts);

      steps.push({
        kind: "model",
        text,
        calls: calls.map((c) => c.name ?? "?"),
        durationMs: Date.now() - turnStart,
      });

      // Sin herramientas pendientes → el modelo ya contestó, terminamos.
      if (calls.length === 0) {
        return {
          ...base,
          text,
          status: text ? "OK" : "EMPTY",
          iterations,
          promptTokens,
          outputTokens,
          durationMs: Date.now() - startedAt,
        };
      }

      // El turno del modelo (con sus functionCall) tiene que quedar en el
      // historial antes de responderle, o Gemini rechaza la continuación.
      const modelTurn = response.candidates?.[0]?.content;
      if (modelTurn) contents.push(modelTurn);

      // Gemini puede emitir varias functionCall en una misma respuesta, y a
      // veces repite la misma con idénticos argumentos. Con una herramienta que
      // muta — crear_reserva — ejecutarlas todas crea DOS reservas: la segunda
      // choca contra la primera y devuelve "no disponible", dejando una huérfana
      // en PENDING_PAYMENT que bloquea la habitación. Pasó al verificar.
      // Una llamada repetida es la misma pregunta: se ejecuta una vez y se
      // devuelve el mismo resultado a las dos.
      const yaEjecutadas = new Map<string, unknown>();
      const responseParts = [];

      for (const call of calls) {
        const name = call.name ?? "";
        const args = (call.args ?? {}) as Record<string, unknown>;
        const huella = `${name}:${JSON.stringify(args)}`;

        let result: unknown;
        if (yaEjecutadas.has(huella)) {
          result = yaEjecutadas.get(huella);
          steps.push({
            kind: "tool",
            name,
            args,
            result,
            ok: true,
            durationMs: 0,
          });
        } else {
          const toolStart = Date.now();
          const ejecucion = await executeTool(name, args, ctx);
          result = ejecucion.result;
          yaEjecutadas.set(huella, result);

          steps.push({
            kind: "tool",
            name,
            args,
            result,
            ok: ejecucion.ok,
            durationMs: Date.now() - toolStart,
          });
        }

        responseParts.push(
          createPartFromFunctionResponse(call.id ?? "", name, {
            output: result,
          })
        );
      }

      contents.push(createUserContent(responseParts));
    }

    // Se agotaron las iteraciones sin respuesta final. Preferimos el último
    // texto que haya emitido el modelo antes que dejar al huésped sin nada.
    const lastText = [...steps]
      .reverse()
      .find((s): s is Extract<AgentStep, { kind: "model" }> => s.kind === "model" && !!s.text)
      ?.text ?? null;

    return {
      ...base,
      text: lastText,
      status: lastText ? "OK" : "FAILED",
      error: lastText ? undefined : `Se alcanzó el tope de ${MAX_ITERATIONS} iteraciones.`,
      iterations,
      promptTokens,
      outputTokens,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[agent:run]", err);
    return {
      ...base,
      text: null,
      status: "FAILED",
      error: message,
      iterations,
      promptTokens,
      outputTokens,
      durationMs: Date.now() - startedAt,
    };
  }
}

/** `generateContent` con backoff exponencial ante errores transitorios. */
async function generateWithRetry(
  params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]
) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await getClient().models.generateContent(params);
    } catch (err) {
      lastError = err;
      if (!isTransient(err) || attempt === MAX_RETRIES) break;

      // Si la API dijo cuánto esperar, mandamos eso; si pide más de lo que
      // estamos dispuestos a hacer esperar al huésped, cortamos acá.
      const pedido = retryAfterMs(err);
      if (pedido !== null && pedido > RETRY_MAX_WAIT_MS) break;

      await sleep(pedido ?? RETRY_BASE_MS * 2 ** attempt);
    }
  }

  throw lastError;
}
