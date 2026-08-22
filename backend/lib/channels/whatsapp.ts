/**
 * Canal de WhatsApp — Cloud API de Meta.
 *
 * Reemplaza a los nodos `whatsApp` del workflow de n8n ("Enviar respuesta al
 * usuario" y "Enviar error al usuario") y al nodo Code "Extraer datos del
 * mensaje". La lógica es la misma; lo que cambia es que el token deja de vivir
 * en el gestor de credenciales de n8n y pasa a ser una variable de entorno.
 */

/**
 * Versión de la Graph API. Meta mantiene cada versión unos dos años y después
 * la retira, así que conviene poder subirla sin tocar código: cuando empiecen
 * a llegar avisos de deprecación, se cambia la env var y listo.
 */
const API_VERSION = process.env.WHATSAPP_API_VERSION ?? "v22.0";

/** Mensaje de disculpa. Texto idéntico al del nodo "Enviar error al usuario". */
export const MENSAJE_DE_ERROR =
  "Disculpá, tuve un problema técnico y no pude procesar tu mensaje. Por favor intentá de nuevo en unos segundos. 🙏";

// ─── Entrada ──────────────────────────────────────────────────────────────────

export type MensajeEntrante = {
  /** id del mensaje en Meta; se usa para deduplicar reintentos. */
  messageId: string;
  /** Número del hotel que recibió el mensaje, para responder por el mismo. */
  phoneNumberId: string;
  /** Teléfono del huésped, tal como lo manda Meta. */
  from: string;
  text: string;
  timestamp: string;
};

/**
 * Extrae el mensaje de texto del payload de Meta.
 *
 * Portado del nodo Code "Extraer datos del mensaje". Devuelve `null` cuando el
 * webhook no trae un mensaje de texto procesable, que es el caso más común:
 * Meta usa el mismo webhook para avisos de entrega y lectura (`statuses`), y
 * para mensajes que no son texto (audio, imagen, ubicación).
 */
type PayloadMeta = {
  body?: PayloadMeta;
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: {
          id?: string;
          from?: string;
          type?: string;
          timestamp?: string;
          text?: { body?: string };
        }[];
      };
    }[];
  }[];
};

export function extraerMensaje(payload: unknown): MensajeEntrante | null {
  const raw = (payload ?? {}) as PayloadMeta;
  const item = raw.body?.entry ? raw.body : raw;
  const value = item.entry?.[0]?.changes?.[0]?.value;
  if (!value) return null;

  const mensaje = value.messages?.[0];
  if (!mensaje || mensaje.type !== "text") return null;

  const text = mensaje.text?.body ?? "";
  if (!text.trim()) return null;

  return {
    messageId: mensaje.id ?? "",
    phoneNumberId: value.metadata?.phone_number_id ?? "",
    from: mensaje.from ?? "",
    text,
    timestamp: mensaje.timestamp ?? String(Math.floor(Date.now() / 1000)),
  };
}

// ─── Salida ───────────────────────────────────────────────────────────────────

/**
 * Argentina: los números móviles llevan un 9 después del código de país
 * (549…), pero la Cloud API espera el número SIN ese 9 para responder. El
 * workflow de n8n hacía este mismo reemplazo en el campo del destinatario.
 */
export function normalizarDestinatario(phone: string): string {
  return phone.replace(/^549/, "54");
}

/**
 * Envía un mensaje de texto por WhatsApp.
 *
 * @param phoneNumberId  Número del hotel, del payload entrante — no de una env
 *                       var: así el bot responde siempre por el mismo número
 *                       por el que le escribieron.
 */
export async function enviarTexto(
  phoneNumberId: string,
  to: string,
  text: string
): Promise<void> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN no está configurada.");
  if (!phoneNumberId) throw new Error("Falta phoneNumberId para enviar el mensaje.");

  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizarDestinatario(to),
        type: "text",
        text: { preview_url: false, body: text },
      }),
    }
  );

  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    throw new Error(`WhatsApp API ${res.status}: ${detalle.slice(0, 500)}`);
  }
}

/**
 * Manda el mensaje de disculpa. Se usa cuando el agente falla, así el huésped
 * no queda esperando una respuesta que nunca llega. Nunca lanza: si además
 * falla el envío de la disculpa, no hay nada más que hacer.
 */
export async function enviarDisculpa(
  phoneNumberId: string,
  to: string
): Promise<void> {
  try {
    await enviarTexto(phoneNumberId, to, MENSAJE_DE_ERROR);
  } catch (err) {
    console.error("[whatsapp] no se pudo enviar el mensaje de error:", err);
  }
}
