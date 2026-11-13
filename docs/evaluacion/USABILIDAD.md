# Prueba de usabilidad del panel

Sección 8 del [protocolo](PROTOCOLO.md). Estudio exploratorio: 3 a 5
participantes, idealmente con experiencia en recepción de hoteles, que no
hayan visto el panel. Cada sesión dura unos 20 minutos.

## Qué se necesita

- Una computadora con el panel abierto en `https://roomly.com.ar/dashboard`,
  **con la sesión ya iniciada** por ustedes (el participante no ve la contraseña).
- Un cronómetro (el del celular alcanza).
- La planilla `datos/usabilidad-tareas.csv`, una fila por participante y tarea.
- El cuestionario SUS: se crea con [crear-sus.gs](crear-sus.gs), igual que el
  formulario de mensajes (script.google.com → pegar → ejecutar `crearSus`).

## Antes de cada sesión (5 minutos)

1. Desde `backend/`: `npx tsx scripts/eval/usabilidad-datos.ts --crear`.
   Crea tres reservas de prueba con fechas relativas al día de la sesión
   (RML-9801 a RML-9803) y guarda los precios actuales de las tarifas.
2. Recargar el panel y comprobar que aparecen las tres reservas.

## Consigna (leerla tal cual)

> Gracias por ayudarnos. Vamos a probar el panel, no a vos: si algo no sale,
> es un problema del panel. Te voy a pedir cinco tareas, de a una. Hacelas
> como te parezca, sin apuro, y si querés, contá en voz alta lo que vas
> pensando. Si en algún momento te trabás y querés abandonar una tarea, decilo
> y pasamos a la siguiente. No te voy a poder ayudar mientras la hacés.

## Tareas (leer una por vez; el cronómetro arranca al terminar de leerla)

1. «Una huésped, Carla Méndez, llama para preguntar para qué fechas es su
   reserva. Encontrala y decime las fechas.»
   *Completa:* dice el ingreso y el egreso correctos.
2. «Jorge Paz acaba de llegar al hotel. Registrá su ingreso.»
   *Completa:* la reserva RML-9802 queda «Hospedado».
3. «Sofía Ríos tenía que llegar ayer y no vino. Dejalo registrado.»
   *Completa:* la reserva RML-9803 queda «No presentó».
4. «Carla Méndez dice que por WhatsApp le confirmaron que pagaba el total.
   Fijate qué le dijo el bot.»
   *Completa:* abre la conversación de RML-9801 y lee la confirmación.
5. «Desde mañana, las habitaciones Suite pasan a costar $30.000 por noche.
   Cambiá el precio.»
   *Completa:* la tarifa de Suite queda en 30.000.

**Qué anotar en la planilla, por tarea:** segundos hasta completarla o
abandonarla; si la completó sin ayuda (`si`/`no`); cantidad de errores (clics
en un lugar equivocado que el participante tuvo que deshacer o rectificar); y
un comentario breve con lo que dijo o lo que lo trabó. Si pasan 3 minutos, se
anota como no completada y se pasa a la siguiente.

## Al terminar

1. El participante completa el cuestionario SUS (10 preguntas, 2 minutos).
2. Pregunta abierta, anotada en la planilla: «¿Qué fue lo más difícil?».
3. Desde `backend/`: `npx tsx scripts/eval/usabilidad-datos.ts --limpiar`.
   Borra las reservas de prueba y restituye el precio que se cambió.

## Análisis

Con la planilla completa y las respuestas del SUS descargadas como
`datos/usabilidad-sus.csv`:

    npx tsx scripts/eval/analizar-usabilidad.ts

Calcula, por tarea, la tasa de éxito sin ayuda, la mediana de tiempo y los
errores, y el puntaje SUS de cada participante y su media. El umbral fijado
en el protocolo es SUS ≥ 68 y cada tarea completada sin ayuda por al menos 3
de cada 4 participantes.
