/**
 * Genera el hash de la contraseña del dashboard.
 *
 *   npm run admin:password
 *
 * Pide la contraseña por teclado en vez de tomarla como argumento: así no
 * queda en el historial del shell ni en la lista de procesos.
 *
 * Imprime DOS formatos, porque el mismo hash se escribe distinto según dónde
 * vaya. Es la fuente de confusión más común de este proyecto:
 *
 *   · En Vercel va el hash tal cual.
 *   · En un archivo .env local hay que escapar los `$` como `\$`, porque
 *     dotenv-expand interpreta `$2b` como una variable a expandir y se come
 *     parte del hash. Por eso `auth.ts` deshace ese escape al leerlo.
 */

import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import bcrypt from "bcryptjs";

const COSTO = 10;

async function pedirClave(rl: readline.Interface, prompt: string): Promise<string> {
  // Ocultar lo que se tipea: readline no lo trae, se intercepta la escritura.
  const output = rl as unknown as { output?: NodeJS.WriteStream };
  const original = output.output?.write.bind(output.output);
  let ocultando = false;

  if (original && output.output) {
    output.output.write = ((chunk: string, ...args: unknown[]) => {
      if (ocultando && !String(chunk).includes("\n")) return true;
      return original(chunk, ...(args as []));
    }) as typeof output.output.write;
  }

  const promesa = rl.question(prompt);
  ocultando = true;
  const clave = await promesa;
  ocultando = false;

  if (original && output.output) output.output.write = original;
  stdout.write("\n");
  return clave;
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const clave = await pedirClave(rl, "Contraseña nueva: ");
    if (clave.length < 8) {
      console.error("\nTiene que tener al menos 8 caracteres.");
      process.exit(1);
    }

    const repetida = await pedirClave(rl, "Repetila: ");
    if (clave !== repetida) {
      console.error("\nNo coinciden.");
      process.exit(1);
    }

    const hash = bcrypt.hashSync(clave, COSTO);

    console.log("\n─── Para Vercel ────────────────────────────────────");
    console.log("Settings → Environment Variables → ADMIN_PASSWORD_HASH\n");
    console.log(hash);

    console.log("\n─── Para backend/.env ──────────────────────────────");
    console.log("Con los $ escapados, si no dotenv se come parte del hash:\n");
    console.log(`ADMIN_PASSWORD_HASH="${hash.replace(/\$/g, "\\$")}"`);

    console.log("\nAcordate de redeployar en Vercel: las variables no se");
    console.log("aplican al deploy que ya está hecho.\n");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
