/**
 * Convierte el CSV del formulario en el corpus y en las planillas de etiquetado.
 *
 *   npx tsx scripts/eval/preparar-corpus.ts [docs/evaluacion/datos/formulario.csv]
 *
 * Genera en docs/evaluacion/datos/:
 *   corpus.json           un mensaje por fila (M001…), con participante, tarjeta y categoría
 *   etiquetas-A.csv       planilla vacía para el autor A
 *   etiquetas-B.csv       planilla vacía para el autor B
 *   corpus.sha256         hash del corpus, para registrar ANTES de correr (sección 3)
 *
 * No pisa un corpus existente: una vez congelado, no se regenera.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATOS, CORPUS, CATEGORIA, leerCsv, escribirCsv, type Mensaje } from "./comun";

const entrada = path.resolve(process.argv[2] ?? path.join(DATOS, "formulario.csv"));
if (fs.existsSync(CORPUS) && !process.argv.includes("--forzar")) {
  console.error(`Ya existe ${CORPUS}: el corpus está congelado. (--forzar sólo antes de la primera corrida)`);
  process.exit(1);
}

const [enc, ...filas] = leerCsv(fs.readFileSync(entrada, "utf8"));
const colParticipante = enc.findIndex((h) => /c[oó]digo de participante/i.test(h));
const tarjetas = enc
  .map((h, i) => ({ i, codigo: h.trim().match(/^([CPRGO]\d)\b/)?.[1] }))
  .filter((t): t is { i: number; codigo: string } => !!t.codigo);
if (colParticipante < 0 || tarjetas.length === 0) {
  console.error("No encontré la columna del código de participante o las de las tarjetas (C1…O2).");
  process.exit(1);
}

const mensajes: Mensaje[] = [];
const excluidos: string[] = [];
const vistos = new Set<string>();
for (const f of filas) {
  const participante = (f[colParticipante] ?? "").trim().toUpperCase();
  if (vistos.has(participante)) { excluidos.push(`${participante}: respuesta repetida, se conserva la primera`); continue; }
  vistos.add(participante);
  for (const t of tarjetas) {
    const texto = (f[t.i] ?? "").trim();
    if (!texto) { excluidos.push(`${participante} ${t.codigo}: vacío`); continue; }
    mensajes.push({
      id: `M${String(mensajes.length + 1).padStart(3, "0")}`,
      participante,
      tarjeta: t.codigo,
      categoria: CATEGORIA[t.codigo[0]],
      texto,
    });
  }
}

fs.mkdirSync(DATOS, { recursive: true });
const json = JSON.stringify(mensajes, null, 1);
fs.writeFileSync(CORPUS, json);
const hash = crypto.createHash("sha256").update(json).digest("hex");
fs.writeFileSync(path.join(DATOS, "corpus.sha256"), `${hash}  corpus.json\n`);

const ENCABEZADO = ["id", "tarjeta", "mensaje", "intencion", "nombre", "checkIn", "checkOut", "personas", "habitacion", "pago", "codigo", "nota"];
for (const autor of ["A", "B"]) {
  const ruta = path.join(DATOS, `etiquetas-${autor}.csv`);
  if (fs.existsSync(ruta)) continue;
  fs.writeFileSync(ruta, escribirCsv([ENCABEZADO, ...mensajes.map((m) => [m.id, m.tarjeta, m.texto])]));
}

const porCategoria = mensajes.reduce<Record<string, number>>((a, m) => ((a[m.categoria] = (a[m.categoria] ?? 0) + 1), a), {});
console.log(`${mensajes.length} mensajes de ${vistos.size} participantes`, porCategoria);
if (excluidos.length) console.log("Excluidos:\n  " + excluidos.join("\n  "));
console.log(`SHA-256 del corpus: ${hash}`);
console.log(`
Etiquetado (sección 4), cada autor en su planilla y sin mirar la del otro:
  intencion  reservar | consultar | modificar | cancelar | avisar_pago | saludar | fuera_de_dominio
  checkIn/checkOut  YYYY-MM-DD, resolviendo fechas relativas contra el martes 01/12/2026
  personas  número · habitacion  número (101…) · pago  DEPOSIT | FULL · codigo  RML-XXXX
  Dejar vacío lo que el mensaje no dice.`);
