/**
 * Calcula las métricas de la sección 7 del protocolo.
 *
 *   npx tsx scripts/eval/analizar.ts
 *
 * Lee de docs/evaluacion/datos/: corpus.json, etiquetas-A.csv, etiquetas-B.csv,
 * etiquetas-final.csv (las de consenso), clasificacion.csv (con acierto_final
 * completo), clave-cegado.json y las corridas. Escribe resultados.md y
 * resultados.json.
 */

import fs from "node:fs";
import path from "node:path";
import { CATEGORIA, CORPUS, CORRIDAS, DATOS, MODELOS, leerJsonl, leerTabla, type Ejecucion, type Mensaje } from "./comun";

// ─── Estadística ──────────────────────────────────────────────────────────────

/** Intervalo de Wilson al 95 % para k aciertos en n. */
export function wilson(k: number, n: number, z = 1.959964): [number, number] {
  if (n === 0) return [NaN, NaN];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centro = (p + (z * z) / (2 * n)) / den;
  const margen = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [centro - margen, centro + margen];
}

/** Prueba exacta de McNemar (binomial sobre los pares discordantes), bilateral. */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  let comb = 1;
  let acum = 0;
  for (let i = 0; i <= Math.min(b, c); i++) {
    if (i > 0) comb = (comb * (n - i + 1)) / i;
    acum += comb;
  }
  return Math.min(1, (2 * acum) / 2 ** n);
}

/** Kappa de Cohen entre dos listas de etiquetas. */
export function kappa(a: string[], b: string[]): number {
  const n = a.length;
  const cats = [...new Set([...a, ...b])];
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = cats.reduce((s, c) => s + (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

function percentil(xs: number[], p: number): number {
  const s = [...xs].sort((x, y) => x - y);
  if (s.length === 0) return NaN;
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.ceil(pos)] - s[lo]) * (pos - lo);
}

const pct = (x: number) => `${(100 * x).toFixed(1).replace(".", ",")} %`;
const si = (v: string) => /^s[ií]$/i.test(v.trim());
const norm = (s: unknown) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

// ─── Datos ────────────────────────────────────────────────────────────────────

function main() {
  const corpus: Mensaje[] = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
  const porId = new Map(corpus.map((m) => [m.id, m]));
  const etA = new Map(leerTabla(path.join(DATOS, "etiquetas-A.csv")).map((f) => [f.id, f]));
  const etB = new Map(leerTabla(path.join(DATOS, "etiquetas-B.csv")).map((f) => [f.id, f]));
  const rutaFinal = path.join(DATOS, "etiquetas-final.csv");
  const etF = fs.existsSync(rutaFinal) ? new Map(leerTabla(rutaFinal).map((f) => [f.id, f])) : etA;

  const { mapa } = JSON.parse(fs.readFileSync(path.join(DATOS, "clave-cegado.json"), "utf8")) as {
    mapa: Record<string, { modelo: string; corrida: number; id: string }>;
  };
  // acierto[modelo][corrida][id]
  const acierto: Record<string, Record<number, Record<string, boolean>>> = {};
  const sinClasificar: string[] = [];
  for (const f of leerTabla(path.join(DATOS, "clasificacion.csv"))) {
    const d = mapa[f.clave];
    if (!d) continue;
    if (!f.acierto_final) { sinClasificar.push(f.clave); continue; }
    ((acierto[d.modelo] ??= {})[d.corrida] ??= {})[d.id] = si(f.acierto_final);
  }

  const ejecuciones: Ejecucion[] = [];
  for (const archivo of fs.readdirSync(CORRIDAS).filter((f) => f.endsWith(".jsonl"))) {
    ejecuciones.push(...new Map(leerJsonl<Ejecucion>(path.join(CORRIDAS, archivo)).map((e) => [e.id, e])).values());
  }

  const out: Record<string, unknown> = { generado: new Date().toISOString(), sinClasificar: sinClasificar.length };
  const md: string[] = ["# Resultados de la evaluación", "", `Generado el ${new Date().toISOString()} por analizar.ts.`, ""];
  if (sinClasificar.length) md.push(`**Atención:** ${sinClasificar.length} respuestas sin acierto_final.`, "");

  // ── Acuerdo entre etiquetadores (sección 4) ───────────────────────────────
  const ids = corpus.map((m) => m.id).filter((id) => etA.get(id)?.intencion && etB.get(id)?.intencion);
  const k = kappa(ids.map((id) => norm(etA.get(id)!.intencion)), ids.map((id) => norm(etB.get(id)!.intencion)));
  const CAMPOS = ["nombre", "checkIn", "checkOut", "personas", "habitacion", "pago", "codigo"];
  const acuerdoCampo = Object.fromEntries(
    CAMPOS.map((c) => [c, ids.filter((id) => norm(etA.get(id)![c]) === norm(etB.get(id)![c])).length / ids.length])
  );
  out.etiquetado = { mensajes: ids.length, kappaIntencion: k, acuerdoCampo };
  md.push("## Acuerdo entre etiquetadores", "", `Kappa de Cohen sobre la intención: **${k.toFixed(2).replace(".", ",")}** (${ids.length} mensajes).`, "",
    "| Campo | Acuerdo |", "|---|---|", ...CAMPOS.map((c) => `| ${c} | ${pct(acuerdoCampo[c])} |`), "");

  // ── Precisión por modelo y corrida ────────────────────────────────────────
  md.push("## Precisión por mensaje", "", "| Modelo | Corrida | Aciertos | Precisión | IC 95 % (Wilson) |", "|---|---|---|---|---|");
  const precision: Record<string, unknown>[] = [];
  for (const [modelo, corridas] of Object.entries(acierto)) {
    for (const [c, r] of Object.entries(corridas)) {
      const v = Object.values(r);
      const kk = v.filter(Boolean).length;
      const [lo, hi] = wilson(kk, v.length);
      precision.push({ modelo, corrida: Number(c), aciertos: kk, n: v.length, precision: kk / v.length, ic: [lo, hi] });
      md.push(`| ${modelo} | ${c} | ${kk}/${v.length} | ${pct(kk / v.length)} | ${pct(lo)} a ${pct(hi)} |`);
    }
  }
  out.precision = precision;

  // ── OE-2: modelo principal, primera corrida ───────────────────────────────
  const p1 = acierto[MODELOS[0]]?.[1] ?? {};
  const v1 = Object.values(p1);
  const k1 = v1.filter(Boolean).length;
  const [lo1] = wilson(k1, v1.length);
  const prec1 = k1 / v1.length;
  const veredicto = prec1 >= 0.9 && lo1 >= 0.85 ? "Cumplido" : prec1 >= 0.9 ? "Compatible, no concluyente" : "No cumplido";
  out.oe2 = { aciertos: k1, n: v1.length, precision: prec1, limiteInferior: lo1, veredicto };
  md.push("", "## OE-2", "", `Modelo principal (${MODELOS[0]}), primera corrida: ${k1}/${v1.length} = **${pct(prec1)}**, límite inferior ${pct(lo1)}. Umbral fijado antes de medir: precisión ≥ 90 % y límite inferior ≥ 85 %. **${veredicto}.**`, "");

  // ── Por categoría ─────────────────────────────────────────────────────────
  md.push("## Precisión por categoría (modelo principal, corrida 1)", "", "| Categoría | Aciertos | Precisión | IC 95 % |", "|---|---|---|---|");
  const porCat: Record<string, unknown> = {};
  for (const cat of Object.values(CATEGORIA)) {
    const v = Object.entries(p1).filter(([id]) => porId.get(id)?.categoria === cat).map(([, x]) => x);
    const kk = v.filter(Boolean).length;
    const [lo, hi] = wilson(kk, v.length);
    porCat[cat] = { aciertos: kk, n: v.length };
    md.push(`| ${cat} | ${kk}/${v.length} | ${pct(kk / v.length)} | ${pct(lo)} a ${pct(hi)} |`);
  }
  out.porCategoria = porCat;

  // ── Variación entre corridas (P2) ─────────────────────────────────────────
  md.push("", "## Variación entre corridas", "", "| Modelo | Corridas | Mismo resultado en todas | Rango de precisión |", "|---|---|---|---|");
  const variacion: Record<string, unknown> = {};
  for (const [modelo, corridas] of Object.entries(acierto)) {
    const cs = Object.values(corridas);
    const comunes = corpus.map((m) => m.id).filter((id) => cs.every((r) => id in r));
    const iguales = comunes.filter((id) => new Set(cs.map((r) => r[id])).size === 1).length;
    const precs = cs.map((r) => Object.values(r).filter(Boolean).length / Object.values(r).length);
    variacion[modelo] = { corridas: cs.length, iguales, comunes: comunes.length, min: Math.min(...precs), max: Math.max(...precs) };
    md.push(`| ${modelo} | ${cs.length} | ${iguales}/${comunes.length} (${pct(iguales / comunes.length)}) | ${pct(Math.min(...precs))} a ${pct(Math.max(...precs))} |`);
  }
  out.variacion = variacion;

  // ── Comparación de modelos (P3) ───────────────────────────────────────────
  const a = acierto[MODELOS[0]]?.[1] ?? {};
  const b = acierto[MODELOS[1]]?.[1] ?? {};
  const pares = Object.keys(a).filter((id) => id in b);
  const soloA = pares.filter((id) => a[id] && !b[id]).length;
  const soloB = pares.filter((id) => !a[id] && b[id]).length;
  const p = mcnemar(soloA, soloB);
  out.comparacion = { pares: pares.length, soloPrincipal: soloA, soloRespaldo: soloB, p };
  md.push("", "## Comparación de modelos (corrida 1)", "",
    `${pares.length} mensajes pareados. Acierta sólo ${MODELOS[0]}: ${soloA}; sólo ${MODELOS[1]}: ${soloB}. McNemar exacta: p = ${p.toFixed(3).replace(".", ",")} → ${p < 0.05 ? "diferencia significativa" : "sin diferencia significativa"} (α = 0,05).`, "");

  // ── Precisión por campo (automática, sobre los argumentos) ────────────────
  const campoArg: Record<string, (e: Ejecucion) => unknown> = {
    nombre: (e) => e.herramientas.find((h) => h.args.guestName)?.args.guestName,
    checkIn: (e) => e.herramientas.find((h) => h.args.checkIn)?.args.checkIn,
    checkOut: (e) => e.herramientas.find((h) => h.args.checkOut)?.args.checkOut,
    personas: (e) => e.herramientas.find((h) => h.args.numGuests !== undefined)?.args.numGuests,
    habitacion: (e) => (e.herramientas.find((h) => h.name === "proponer_reserva")?.result as { propuesta?: { room?: string } })?.propuesta?.room,
    pago: (e) => e.herramientas.find((h) => h.args.paymentType)?.args.paymentType,
    codigo: (e) => e.herramientas.find((h) => h.args.code)?.args.code,
  };
  md.push("## Precisión por campo (modelo principal, corrida 1)", "",
    "Sólo los mensajes donde el dato está en la etiqueta y el agente lo pasó a una herramienta.", "",
    "| Campo | Correctos | Comparados |", "|---|---|---|");
  const porCampo: Record<string, unknown> = {};
  const e1 = ejecuciones.filter((e) => e.modelo === MODELOS[0] && e.corrida === 1);
  for (const c of CAMPOS) {
    let ok = 0, n = 0;
    for (const e of e1) {
      const oro = etF.get(e.id)?.[c];
      const val = campoArg[c](e);
      if (!oro || val === undefined || val === null || val === "") continue;
      n++;
      if (norm(oro) === norm(val)) ok++;
    }
    porCampo[c] = { correctos: ok, comparados: n };
    md.push(`| ${c} | ${ok} | ${n} |`);
  }
  out.porCampo = porCampo;

  // ── Latencia ──────────────────────────────────────────────────────────────
  md.push("", "## Latencia de la ejecución del agente (sin WhatsApp)", "", "| Modelo | Ejecuciones | Mediana | Percentil 95 |", "|---|---|---|---|");
  const latencia: Record<string, unknown> = {};
  for (const modelo of new Set(ejecuciones.map((e) => e.modelo))) {
    const d = ejecuciones.filter((e) => e.modelo === modelo && e.status === "OK").map((e) => e.durationMs);
    latencia[modelo] = { n: d.length, mediana: percentil(d, 0.5), p95: percentil(d, 0.95) };
    md.push(`| ${modelo} | ${d.length} | ${(percentil(d, 0.5) / 1000).toFixed(1).replace(".", ",")} s | ${(percentil(d, 0.95) / 1000).toFixed(1).replace(".", ",")} s |`);
  }
  out.latencia = latencia;

  fs.writeFileSync(path.join(DATOS, "resultados.json"), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(DATOS, "resultados.md"), md.join("\n") + "\n");
  console.log(md.join("\n"));
}

if (require.main === module) main();
