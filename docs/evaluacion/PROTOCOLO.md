# Protocolo de evaluación de Roomly (iteración 10)

Versión 1 · redactado el 12/11/2026, **antes de recolectar ningún mensaje**.

Este documento fija de antemano qué se mide, cómo se mide y qué resultado se
considera suficiente. Se versiona en el repositorio con la etiqueta anotada
`protocolo-evaluacion-v1`: la fecha del commit y la etiqueta prueban que los
umbrales se fijaron antes de medir. Cualquier cambio posterior se registra en la
sección 9 como desvío, con su motivo, y no reemplaza este texto.

## 1. Preguntas

- **P1 (OE-2).** ¿Con qué precisión interpreta el agente los mensajes de
  huéspedes escritos por personas ajenas al desarrollo?
- **P2.** ¿Cuánto varía el resultado entre corridas del mismo modelo con los
  mismos mensajes?
- **P3.** ¿Cambia la precisión con otro modelo de la misma API?
- **P4.** ¿Puede el personal de un hotel usar el panel sin ayuda?

## 2. Versión evaluada

El código de la etiqueta `v1.3-entrega` (iteración 10, con «proponer» separado
de «confirmar»). El prompt es el del código (`backend/lib/agent/prompt.ts`): no
hay prompt personalizado en `BotConfig`. Ningún cambio de código ni de prompt
durante la evaluación; si hiciera falta uno, se registra como desvío y se
repiten las corridas afectadas.

## 3. Corpus (P1, P2, P3)

**Participantes.** Al menos 15 personas que no participaron del desarrollo ni
conocen el sistema, mayores de edad, hablantes de español rioplatense. Se
excluye a los autores y a quien haya visto el código o las conversaciones de
prueba. No se recolectan datos personales: cada participante se identifica con
un código (P01, P02…) y usa nombres, correos y fechas ficticios.

**Consigna.** Cada participante recibe tarjetas de escenario y escribe, como
lo haría por WhatsApp, el mensaje que le mandaría al hotel. Las tarjetas dicen
qué quiere el huésped, no cómo decirlo (por ejemplo: «querés una habitación
para vos y tu pareja el fin de semana largo de diciembre, y preferís pagar una
seña»). Las tarjetas se reparten de modo que el corpus cubra cinco categorías:

| Categoría | Qué incluye | Mínimo |
|---|---|---|
| Completo | Todos los datos para reservar en un solo mensaje | 30 |
| Parcial | Faltan datos (fechas, personas o nombre) | 30 |
| Fecha relativa | «el finde», «el viernes que viene», «para mañana» | 30 |
| Gestión | Consultar, modificar o cancelar con un código RML | 30 |
| Otro | Saludos, preguntas fuera del dominio, mensajes ambiguos | 20 |

**Tamaño.** Al menos 140 mensajes. Con 140 mensajes y una precisión cercana al
90 %, el intervalo de Wilson al 95 % tiene un ancho aproximado de ±5 puntos.

**Congelamiento.** Antes de la primera corrida se calcula el SHA-256 del
archivo del corpus y se lo registra en `docs/evidencia/SHA256SUMS`. El corpus
no se edita después; los mensajes ilegibles se excluyen con su motivo, sin
reescribirlos.

## 4. Etiquetado (antes de correr)

Los dos autores etiquetan cada mensaje **por separado y antes de cualquier
corrida**: intención (reservar, consultar, modificar, cancelar, avisar un pago,
saludar o cerrar, fuera del dominio) y datos presentes (nombre, ingreso,
egreso, cantidad de personas, habitación, modalidad de pago, código). Las
fechas relativas se resuelven contra la fecha de referencia fija de la
sección 5.

Se informa el acuerdo entre los dos etiquetadores con el kappa de Cohen sobre
la intención y la proporción de acuerdo por campo. Los desacuerdos se
resuelven por discusión y queda registrada la etiqueta original de cada uno.

## 5. Ejecución

Un script corre cada mensaje contra el agente sin pasar por WhatsApp, con
historial vacío y fecha de referencia fija **martes 01/12/2026, 10:00
(America/Argentina/Buenos_Aires)** mediante la opción `now` de `runAgent`. Las
herramientas que escriben (`proponer_reserva`, que guarda la propuesta,
`crear_reserva`, `modificar_reserva` y `cancelar_reserva`) se reemplazan por
dobles que registran los argumentos sin tocar la base ni Mercado Pago; las de
lectura consultan una copia aislada de la base (una branch de Neon) con el
inventario del hotel de prueba, para que la disponibilidad no cambie entre
corridas.

- **Modelos:** `gemini-3.1-flash-lite` (principal en producción) y
  `gemini-3.5-flash-lite` (respaldo en producción). Temperatura 0,1, como en
  producción.
- **Corridas:** tres por modelo y mensaje (140 × 2 × 3 = 840 ejecuciones).
- **Registro:** por ejecución, el texto de la respuesta, las herramientas
  invocadas con sus argumentos, la duración y los tokens, en un JSON por
  corrida que se agrega a `docs/evidencia` con su hash.

## 6. Criterio de acierto

Un mensaje está **bien interpretado** si la respuesta del agente (texto y
herramientas invocadas) es coherente con la intención etiquetada y todos los
datos presentes en el mensaje aparecen correctos en los argumentos de las
herramientas o en el resumen que el agente le devuelve al huésped, sin datos
que el huésped no dio. Es el mismo criterio de la sección 5.6 del informe,
aplicado ahora a mensajes ajenos.

La clasificación de las respuestas la hacen los dos autores **sin saber qué
modelo ni qué corrida produjo cada una** (las respuestas se presentan
mezcladas y con un identificador aleatorio).

## 7. Métricas y umbrales (fijados antes de medir)

| Métrica | Cálculo | Umbral |
|---|---|---|
| Precisión por mensaje (OE-2) | Aciertos / mensajes, modelo principal, primera corrida; intervalo de Wilson al 95 % | **Cumplido** si la precisión es ≥ 90 % **y** el límite inferior del intervalo es ≥ 85 %. **Compatible, no concluyente** si la precisión es ≥ 90 % y el límite inferior < 85 %. **No cumplido** si la precisión es < 90 %. |
| Precisión por campo | Por cada dato etiquetado | Se informa, sin umbral |
| Precisión por categoría | Por cada fila de la tabla de la sección 3 | Se informa, sin umbral |
| Variación entre corridas (P2) | Proporción de mensajes con el mismo resultado en las tres corridas; rango de la precisión entre corridas | Se informa, sin umbral |
| Comparación de modelos (P3) | Diferencia de precisión con prueba de McNemar sobre los mismos mensajes (primera corrida) | Diferencia significativa si p < 0,05 |
| Latencia | Mediana y percentil 95 de la duración de la ejecución del agente (sin WhatsApp) | Se informa, sin umbral |

## 8. Prueba de usabilidad del panel (P4)

**Participantes.** Entre 3 y 5 personas ajenas al desarrollo, idealmente con
experiencia en recepción de hoteles. Estudio exploratorio: no se generalizan
los resultados.

**Tareas** (sin explicación previa del panel, con datos ficticios):

1. Encontrar la reserva de un huésped por su nombre y decir para qué fechas es.
2. Registrar el ingreso de una reserva confirmada que llega hoy.
3. Marcar como no presentada una reserva del día anterior.
4. Ver la conversación de WhatsApp de una reserva.
5. Cambiar el precio por noche de un tipo de habitación.

**Registro.** Tiempo por tarea, si la completó sin ayuda, errores y
comentarios. Al final, el cuestionario System Usability Scale (SUS).

**Umbral.** SUS ≥ 68, el promedio de referencia de la escala; cada tarea
completada sin ayuda por al menos 3 de cada 4 participantes.

## 9. Desvíos

Ninguno a la fecha de la etiqueta.
