/**
 * Utilidades de la evaluación (docs/evaluacion/PROTOCOLO.md): CSV, rutas y
 * tipos compartidos por preparar-corpus, evaluar, cegar y analizar.
 */

import fs from "node:fs";
import path from "node:path";

/** EVAL_DATOS permite ensayar el circuito en otra carpeta sin tocar el corpus real. */
export const DATOS = path.resolve(process.env.EVAL_DATOS ?? path.join(__dirname, "../../../docs/evaluacion/datos"));
export const CORPUS = path.join(DATOS, "corpus.json");
export const CORRIDAS = path.join(DATOS, "corridas");

/** Fecha de referencia del protocolo: martes 01/12/2026, 10:00 en Argentina. */
export const FECHA_REFERENCIA = new Date("2026-12-01T13:00:00Z");

export const MODELOS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"] as const;

export const CATEGORIA: Record<string, string> = {
  C: "Completo",
  P: "Parcial",
  R: "Fecha relativa",
  G: "Gestión",
  O: "Otro",
};

export type Mensaje = { id: string; participante: string; tarjeta: string; categoria: string; texto: string };

export type Ejecucion = {
  id: string;
  modelo: string;
  corrida: number;
  texto: string;
  respuesta: string | null;
  herramientas: { name: string; args: Record<string, unknown>; ok: boolean; result?: unknown }[];
  status: string;
  error?: string;
  durationMs: number;
  promptTokens?: number;
  outputTokens?: number;
  at: string;
};

// ─── CSV (RFC 4180: comillas dobles, saltos de línea dentro de campos) ───────

export function leerCsv(texto: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let comillas = false;
  const t = texto.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (comillas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      fila.push(campo); filas.push(fila); fila = []; campo = "";
    } else campo += c;
  }
  if (campo !== "" || fila.length > 0) { fila.push(campo); filas.push(fila); }
  return filas.filter((f) => f.some((x) => x.trim() !== ""));
}

export function escribirCsv(filas: (string | number | null | undefined)[][]): string {
  const celda = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + filas.map((f) => f.map(celda).join(",")).join("\r\n") + "\r\n";
}

/** Filas de un CSV con encabezado, como objetos. */
export function leerTabla(ruta: string): Record<string, string>[] {
  const [enc, ...filas] = leerCsv(fs.readFileSync(ruta, "utf8"));
  return filas.map((f) => Object.fromEntries(enc.map((h, i) => [h.trim(), (f[i] ?? "").trim()])));
}

export function leerJsonl<T>(ruta: string): T[] {
  if (!fs.existsSync(ruta)) return [];
  return fs.readFileSync(ruta, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

/** PRNG con semilla (mulberry32), para que el cegado sea reproducible. */
export function azar(semilla: number) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
