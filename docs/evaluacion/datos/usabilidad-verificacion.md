# Verificación de las tareas de usabilidad en la base

Después de cada sesión, y antes de borrar los datos de prueba con
`usabilidad-datos.ts --limpiar`, se consultó la base de producción (solo
lectura) para comprobar el resultado de las tareas 2, 3 y 5. Las horas son las
de los registros de AuditLog (UTC). Los registros se borraron con la limpieza,
por lo que esta es la constancia de lo observado.

| Participante | RML-9802 (tarea 2) | RML-9803 (tarea 3) | Tarifa Suite (tarea 5) |
|---|---|---|---|
| U01 | CHECKED_IN, 03:04:09 | NO_SHOW, 03:04:53 | 30000 |
| U02 | CHECKED_IN, 03:22:45 | NO_SHOW, 03:22:52 | 30000 |
| U03 | CHECKED_IN, 03:27:22 | NO_SHOW, 03:27:29 | 30000 |
| U04 | CHECKED_IN, 03:30:13 | NO_SHOW, 03:30:17 | 30000 |

La primera sesión de U02 se hizo en un entorno local: la consulta posterior
mostró RML-9802 y RML-9803 todavía en CONFIRMED y la Suite en 28000, por lo que
U02 repitió las tareas en producción (desvío 2 del protocolo).

Los tiempos de la planilla se tomaron con cronómetro manual y son aproximados.
