/**
 * Resultados de la prueba de usabilidad del panel (USABILIDAD.md).
 *
 *   npx tsx scripts/eval/analizar-usabilidad.ts
 *
 * Lee datos/usabilidad-tareas.csv (planilla del facilitador) y
 * datos/usabilidad-sus.csv (respuestas del cuestionario descargadas de Google
 * Forms). Escribe datos/usabilidad-resultados.md.
 */

import fs from "node:fs";
import path from "node:path";
import { DATOS, leerTabla } from "./comun";

/** Puntaje SUS: ítems impares (x − 1), pares (5 − x), suma × 2,5. */
export function puntajeSus(r: number[]): number {
  if (r.length !== 10 || r.some((x) => !(x >= 1 && x <= 5))) return NaN;
  return r.reduce((s, x, i) => s + (i % 2 === 0 ? x - 1 : 5 - x), 0) * 2.5;
}

const mediana = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (x: number, d = 1) => (Number.isNaN(x) ? "—" : x.toFixed(d).replace(".", ","));

function main() {
  const tareas = leerTabla(path.join(DATOS, "usabilidad-tareas.csv")).filter((f) => /^\d$/.test(f.tarea) && f.segundos);
  const md = ["# Resultados de la prueba de usabilidad", "", "| Tarea | Participantes | Sin ayuda | Mediana (s) | Errores (total) | Umbral (≥ 75 % sin ayuda) |", "|---|---|---|---|---|---|"];
  for (const t of ["1", "2", "3", "4", "5"]) {
    const f = tareas.filter((x) => x.tarea === t);
    const ok = f.filter((x) => /^s[ií]$/i.test(x.sin_ayuda)).length;
    const err = f.reduce((s, x) => s + (Number(x.errores) || 0), 0);
    md.push(`| ${t} | ${f.length} | ${ok}/${f.length} | ${fmt(mediana(f.map((x) => Number(x.segundos))), 0)} | ${err} | ${f.length && ok / f.length >= 0.75 ? "cumple" : "no cumple"} |`);
  }

  const rutaSus = path.join(DATOS, "usabilidad-sus.csv");
  if (fs.existsSync(rutaSus)) {
    const filas = leerTabla(rutaSus);
    const claves = Object.keys(filas[0] ?? {});
    const cols = Array.from({ length: 10 }, (_, i) => claves.find((c) => c.startsWith(`S${i + 1}.`))!);
    const colPart = claves.find((c) => /c[oó]digo de participante/i.test(c))!;
    const puntajes = filas.map((f) => ({ p: f[colPart], s: puntajeSus(cols.map((c) => Number(f[c]))) }));
    const validos = puntajes.filter((x) => !Number.isNaN(x.s)).map((x) => x.s);
    const media = validos.reduce((a, b) => a + b, 0) / validos.length;
    md.push("", "## System Usability Scale", "", "| Participante | SUS |", "|---|---|",
      ...puntajes.map((x) => `| ${x.p} | ${fmt(x.s)} |`), "",
      `Media: **${fmt(media)}** (n = ${validos.length}); mínimo ${fmt(Math.min(...validos))}, máximo ${fmt(Math.max(...validos))}. Umbral del protocolo: 68 → **${media >= 68 ? "cumple" : "no cumple"}**.`);
  } else {
    md.push("", "(Falta datos/usabilidad-sus.csv.)");
  }

  const comentarios = leerTabla(path.join(DATOS, "usabilidad-tareas.csv")).filter((f) => f.comentario);
  if (comentarios.length) md.push("", "## Comentarios", "", ...comentarios.map((f) => `- ${f.participante}, tarea ${f.tarea}: ${f.comentario}`));

  fs.writeFileSync(path.join(DATOS, "usabilidad-resultados.md"), md.join("\n") + "\n");
  console.log(md.join("\n"));
}

if (require.main === module) main();
