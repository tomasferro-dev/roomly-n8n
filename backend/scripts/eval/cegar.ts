/**
 * Arma la planilla de clasificación ciega (sección 6 del protocolo).
 *
 *   npx tsx scripts/eval/cegar.ts [--semilla 20261201]
 *
 * Junta todas las corridas, mezcla las respuestas y les pone una clave al azar,
 * de modo que quien clasifica no sabe qué modelo ni qué corrida produjo cada una.
 *
 *   clasificacion.csv   lo que ven los autores: clave, mensaje, respuesta,
 *                       herramientas, y las columnas acierto_A, acierto_B,
 *                       acierto_final (Sí/No) y nota
 *   clave-cegado.json   clave → modelo y corrida. NO abrirlo hasta terminar
 *                       de clasificar; lo usa analizar.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { DATOS, CORRIDAS, azar, escribirCsv, leerJsonl, type Ejecucion } from "./comun";

const i = process.argv.indexOf("--semilla");
const semilla = i >= 0 ? Number(process.argv[i + 1]) : 20261201;
const salida = path.join(DATOS, "clasificacion.csv");
if (fs.existsSync(salida)) {
  console.error(`Ya existe ${salida}: no se regenera para no perder la clasificación.`);
  process.exit(1);
}

const ejecuciones: Ejecucion[] = [];
for (const archivo of fs.readdirSync(CORRIDAS).filter((f) => f.endsWith(".jsonl"))) {
  const ultimas = new Map(leerJsonl<Ejecucion>(path.join(CORRIDAS, archivo)).map((e) => [e.id, e]));
  ejecuciones.push(...ultimas.values());
}

const rnd = azar(semilla);
for (let k = ejecuciones.length - 1; k > 0; k--) {
  const j = Math.floor(rnd() * (k + 1));
  [ejecuciones[k], ejecuciones[j]] = [ejecuciones[j], ejecuciones[k]];
}

const usadas = new Set<string>();
const clave = () => {
  let c: string;
  do c = "K" + Math.floor(rnd() * 1e6).toString().padStart(6, "0"); while (usadas.has(c));
  usadas.add(c);
  return c;
};

const resumen = (e: Ejecucion) =>
  e.herramientas.map((h) => `${h.name}(${JSON.stringify(h.args)})${h.ok ? "" : " → error"}`).join("\n");

const filas: (string | number)[][] = [["clave", "id", "mensaje", "respuesta", "herramientas", "acierto_A", "acierto_B", "acierto_final", "nota"]];
const mapa: Record<string, { modelo: string; corrida: number; id: string }> = {};
for (const e of ejecuciones) {
  const c = clave();
  mapa[c] = { modelo: e.modelo, corrida: e.corrida, id: e.id };
  filas.push([c, e.id, e.texto, e.status === "FAILED" ? `(FALLÓ: ${e.error ?? ""})` : e.respuesta ?? "", resumen(e)]);
}

fs.writeFileSync(salida, escribirCsv(filas));
fs.writeFileSync(path.join(DATOS, "clave-cegado.json"), JSON.stringify({ semilla, mapa }, null, 1));
console.log(`${ejecuciones.length} respuestas mezcladas en ${salida}`);
