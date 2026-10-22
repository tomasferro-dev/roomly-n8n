/**
 * Verificación de firmas de los webhooks entrantes.
 *
 * Funciones puras (sin red ni base) para poder probarlas en `agent:check`.
 * Ambas comparan en tiempo constante para no filtrar por timing cuánto de la
 * firma coincidió.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

function hmacHex(secret: string, message: string | Buffer): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Meta firma cada POST del webhook con HMAC-SHA256 del cuerpo CRUDO, usando el
 * App Secret de la aplicación, y lo manda en `X-Hub-Signature-256: sha256=<hex>`.
 *
 * Tiene que ser el cuerpo tal como llegó: Meta escapa los caracteres no ASCII
 * (la é viaja como la secuencia de escape u00e9 precedida de barra invertida),
 * así que parsear y volver a serializar el JSON da otra firma.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null,
  appSecret: string
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const recibida = header.slice("sha256=".length).trim().toLowerCase();
  return sameHex(hmacHex(appSecret, Buffer.from(rawBody, "utf8")), recibida);
}

/**
 * Mercado Pago manda `x-signature: ts=<timestamp>,v1=<hex>` y `x-request-id`.
 * La firma es HMAC-SHA256, con el secreto de "Tus integraciones > Webhooks",
 * sobre el manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`.
 *
 * Según la documentación, si `data.id` es alfanumérico va en minúsculas, y las
 * partes cuyo valor no vino se omiten del manifiesto.
 */
export function verifyMercadoPagoSignature(opts: {
  header: string | null;
  requestId: string | null;
  dataId: string | null;
  secret: string;
}): boolean {
  const { header, requestId, dataId, secret } = opts;
  if (!header) return false;

  let ts: string | undefined;
  let v1: string | undefined;
  for (const parte of header.split(",")) {
    const [clave, ...resto] = parte.split("=");
    const valor = resto.join("=").trim();
    if (clave.trim() === "ts") ts = valor;
    if (clave.trim() === "v1") v1 = valor.toLowerCase();
  }
  if (!ts || !v1) return false;

  let manifiesto = "";
  if (dataId) manifiesto += `id:${/[a-z]/i.test(dataId) ? dataId.toLowerCase() : dataId};`;
  if (requestId) manifiesto += `request-id:${requestId};`;
  manifiesto += `ts:${ts};`;

  return sameHex(hmacHex(secret, manifiesto), v1);
}
