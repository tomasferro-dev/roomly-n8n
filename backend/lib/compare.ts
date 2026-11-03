/**
 * Comparación de secretos en tiempo constante, como las firmas de
 * lib/signatures.ts. No usa timingSafeEqual porque el middleware puede correr
 * en el runtime Edge, que no tiene node:crypto.
 */
export function mismoSecreto(a: string, b: string): boolean {
  if (a.length !== b.length || b === "") return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
