# Resultados de la evaluación

Generado el 2026-11-13T13:28:20.613Z por analizar.ts.

## Acuerdo entre etiquetadores

Kappa de Cohen sobre la intención: **0,92** (150 mensajes).

| Campo | Acuerdo |
|---|---|
| nombre | 100,0 % |
| checkIn | 100,0 % |
| checkOut | 100,0 % |
| personas | 100,0 % |
| habitacion | 100,0 % |
| pago | 100,0 % |
| codigo | 100,0 % |

## Precisión por mensaje

| Modelo | Corrida | Aciertos | Precisión | IC 95 % (Wilson) |
|---|---|---|---|---|
| gemini-3.1-flash-lite | 1 | 23/29 | 79,3 % | 61,6 % a 90,2 % |

## OE-2

Modelo principal (gemini-3.1-flash-lite), primera corrida: 23/29 = **79,3 %**, límite inferior 61,6 %. Umbral fijado antes de medir: precisión ≥ 90 % y límite inferior ≥ 85 %. **No cumplido.**

## Precisión por categoría (modelo principal, corrida 1)

| Categoría | Aciertos | Precisión | IC 95 % |
|---|---|---|---|
| Completo | 6/6 | 100,0 % | 61,0 % a 100,0 % |
| Parcial | 5/6 | 83,3 % | 43,6 % a 97,0 % |
| Fecha relativa | 6/6 | 100,0 % | 61,0 % a 100,0 % |
| Gestión | 4/6 | 66,7 % | 30,0 % a 90,3 % |
| Otro | 2/5 | 40,0 % | 11,8 % a 76,9 % |

## Variación entre corridas

| Modelo | Corridas | Mismo resultado en todas | Rango de precisión |
|---|---|---|---|
| gemini-3.1-flash-lite | 1 | No se informa: hace falta más de una corrida | — |

## Comparación de modelos (corrida 1)

No se informa: se corrió un solo modelo.

## Acuerdo entre autores al clasificar

Coincidieron en 27 de 29 respuestas; kappa de Cohen 0,76. Los desacuerdos se resolvieron por consenso (nota de cada fila en clasificacion.csv).

## Precisión por campo (modelo principal, corrida 1)

Sólo los mensajes donde el dato está en la etiqueta y el agente lo pasó a una herramienta.

| Campo | Correctos | Comparados |
|---|---|---|
| nombre | 0 | 0 |
| checkIn | 13 | 14 |
| checkOut | 14 | 14 |
| personas | 0 | 0 |
| habitacion | 0 | 0 |
| pago | 0 | 0 |
| codigo | 6 | 6 |

## Latencia de la ejecución del agente (sin WhatsApp)

| Modelo | Ejecuciones | Mediana | Percentil 95 |
|---|---|---|---|
| gemini-3.1-flash-lite | 29 | 14,6 s | 77,1 s |
