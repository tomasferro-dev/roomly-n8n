# Evaluación: paso a paso

Qué se mide y con qué umbrales: [PROTOCOLO.md](PROTOCOLO.md) (etiqueta
`protocolo-evaluacion-v1`). Las tarjetas y el formulario: [TARJETAS.md](TARJETAS.md).
Los comandos se corren desde `backend/`.

| # | Quién | Qué |
|---|---|---|
| 1 | Autores | Armar el formulario de TARJETAS.md y conseguir 15 o más participantes ajenos al proyecto. Asignarles códigos P01, P02… |
| 2 | Autores | Al cerrar, descargar las respuestas como CSV en `docs/evaluacion/datos/formulario.csv`. |
| 3 | Script | `npx tsx scripts/eval/preparar-corpus.ts` → `corpus.json`, su SHA-256 y las planillas `etiquetas-A.csv` y `etiquetas-B.csv`. Commitear el corpus y el hash **antes** de correr. |
| 4 | Autores | Cada uno completa su planilla de etiquetas por separado. Después, juntos, arman `etiquetas-final.csv` resolviendo los desacuerdos (sin borrar las dos originales). |
| 5 | Autores | Crear una branch de Neon a partir de producción y poner su cadena de conexión como `DATABASE_URL` en un `.env` local (nunca en el repo). |
| 6 | Script | Seis corridas, con `EVAL_BRANCH_OK=1`: `npx tsx scripts/eval/evaluar.ts --modelo gemini-3.1-flash-lite --corrida 1` (y 2 y 3), lo mismo con `gemini-3.5-flash-lite`. Si una corrida se corta, volver a lanzarla retoma donde quedó. |
| 7 | Script | `npx tsx scripts/eval/cegar.ts` → `clasificacion.csv`. **No abrir** `clave-cegado.json`. |
| 8 | Autores | Clasificar cada respuesta (columnas `acierto_A` y `acierto_B`, por separado) y acordar `acierto_final` (Sí/No) con el criterio de la sección 6. |
| 9 | Script | `npx tsx scripts/eval/analizar.ts` → `resultados.md` y `resultados.json`. |

Notas:

- En el acuerdo por campo de `analizar.ts` cuentan también los casos en que
  los dos etiquetadores dejaron el campo vacío.
- La precisión por campo se calcula sola, comparando las etiquetas de consenso
  con los argumentos que el agente pasó a las herramientas.
- Con la cuota gratuita de Gemini, cada corrida de 150 mensajes tarda entre 15
  y 25 minutos (pausa de 4,5 s entre mensajes más los reintentos ante 429).
