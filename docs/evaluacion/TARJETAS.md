# Tarjetas de escenario y formulario de recolección

Corpus de la sección 3 del [protocolo](PROTOCOLO.md). Cada participante
contesta las diez tarjetas: con 15 participantes son 150 mensajes, 30 por
categoría.

## Cómo armar el formulario (Google Forms)

1. Formulario nuevo: **«Roomly: ¿cómo le escribirías a un hotel?»**.
2. Configuración: **no** recolectar correos; una respuesta por persona no hace
   falta (no se pide iniciar sesión).
3. Primera sección, texto de bienvenida (copiar el bloque «Consigna»).
4. Pregunta 1, respuesta corta, obligatoria: **«Tu código de participante»**
   (P01, P02…; se lo dan ustedes a cada persona).
5. Pregunta 2, casillas, obligatoria: **«Confirmo que no participé del
   desarrollo de Roomly, que soy mayor de edad y que acepto que mis mensajes se
   usen, sin datos personales, en la evaluación de un trabajo final»**.
6. Preguntas 3 a 12: una por tarjeta, en el orden de abajo, tipo **párrafo**,
   obligatorias. Título = el código de la tarjeta y su texto (por ejemplo
   «C1. Querés reservar…»). Descripción: «Escribí el mensaje tal como lo
   mandarías por WhatsApp».
7. Respuestas → vincular con Hojas de cálculo; al cerrar la recolección,
   Archivo → Descargar → CSV, y guardarlo como
   `docs/evaluacion/datos/formulario.csv`.

## Consigna (texto de bienvenida)

> Estamos evaluando un asistente que atiende las reservas de un hotel por
> WhatsApp. No vas a hablar con el asistente: sólo vas a escribir mensajes.
>
> Imaginá que **hoy es martes 1 de diciembre de 2026**. En cada pregunta hay una
> situación. Escribí el mensaje que le mandarías al hotel por WhatsApp en esa
> situación, con tus palabras, como escribís normalmente (abreviaturas, sin
> tildes, lo que te salga). No copies el texto de la situación.
>
> Usá **nombres inventados**, no el tuyo. No pongas teléfonos, documentos ni
> correos reales. Te lleva unos 10 minutos. ¡Gracias!

## Tarjetas

| Código | Categoría | Situación (texto de la pregunta) |
|---|---|---|
| C1 | Completo | Querés reservar para vos y tu pareja, del viernes 18 al domingo 20 de diciembre, y pagar una seña. Pedilo en un solo mensaje, con todos los datos y un nombre inventado. |
| C2 | Completo | Viajás con tres amigos (cuatro personas en total) del 27 al 30 de diciembre y querés pagar todo de una vez. Pedí la reserva con todos los datos en un solo mensaje, con un nombre inventado. |
| P1 | Parcial | Querés saber si hay lugar para el fin de semana del 12 de diciembre, pero todavía no sabés cuántos van a ir. |
| P2 | Parcial | Querés reservar una habitación para dos personas, pero todavía no tenés las fechas decididas. |
| R1 | Fecha relativa | Querés ir este fin de semana, sábado y domingo, vos solo o sola. |
| R2 | Fecha relativa | Querés llegar el viernes que viene y quedarte tres noches, con otra persona. |
| G1 | Gestión | Ya tenés la reserva RML-4821 y querés irte un día más tarde de lo que habías reservado. |
| G2 | Gestión | Ya tenés la reserva RML-3307 y no vas a poder viajar: querés cancelarla. |
| O1 | Otro | Antes de reservar, querés saber si aceptan mascotas. |
| O2 | Otro | Recién encontrás el WhatsApp del hotel. Escribí lo primero que le mandarías. |

## Reservas de las tarjetas G1 y G2

En la ejecución, `consultar_reserva` es un doble que devuelve, para cualquier
código, esta reserva del mismo teléfono: habitación 101, ingreso 10/12/2026,
egreso 12/12/2026, dos personas, confirmada. Al etiquetar G1, «un día más
tarde» es entonces egreso 13/12/2026.
