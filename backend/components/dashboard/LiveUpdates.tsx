"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Mantiene el dashboard al día consultando /api/dashboard/pulse.
 *
 * Antes esto abría un EventSource contra un endpoint SSE que escuchaba Redis.
 * En Vercel una conexión así se corta al llegar al `maxDuration` de la función
 * y el dashboard se queda mudo sin avisar, así que se cambió por sondeo.
 *
 * Sólo llama a router.refresh() cuando la huella cambia: sin eso estaríamos
 * re-renderizando los Server Components cada pocos segundos sin motivo.
 *
 * No renderiza nada. Se monta una vez en el layout del dashboard.
 */

/** Cada cuánto se pregunta, con la pestaña visible. */
const INTERVALO_MS = 10_000;

export default function LiveUpdates() {
  const router = useRouter();
  const huella = useRef<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    let timer: ReturnType<typeof setTimeout>;

    async function consultar() {
      // Con la pestaña en segundo plano no hace falta preguntar: nadie está
      // mirando, y en Vercel cada consulta es una invocación que se paga.
      if (document.visibilityState !== "visible") return;

      try {
        const res = await fetch("/api/dashboard/pulse", { cache: "no-store" });
        if (!res.ok || cancelado) return;

        const { v } = (await res.json()) as { v: string };

        // La primera respuesta sólo fija la referencia: en ese momento el
        // dashboard ya está mostrando datos frescos del render del servidor.
        if (huella.current !== null && huella.current !== v) {
          router.refresh();
        }
        huella.current = v;
      } catch {
        // Un fallo de red suelto no es motivo de nada: se reintenta al toque
        // siguiente.
      }
    }

    function programar() {
      timer = setTimeout(async () => {
        await consultar();
        if (!cancelado) programar();
      }, INTERVALO_MS);
    }

    // Al volver a la pestaña, mirar enseguida en vez de esperar el ciclo.
    function alVolver() {
      if (document.visibilityState === "visible") void consultar();
    }

    document.addEventListener("visibilitychange", alVolver);
    programar();

    return () => {
      cancelado = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [router]);

  return null;
}
