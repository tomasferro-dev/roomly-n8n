# Roomly – Tiempo real en el dashboard (SSE + Redis Pub/Sub)

El dashboard se actualiza automáticamente cuando llega una reserva desde WhatsApp,
sin necesidad de recargar la página. Esta documento explica cómo funciona.

---

## ¿Qué tecnología se usa y por qué?

### SSE (Server-Sent Events), no WebSockets

**WebSockets** son bidireccionales: el browser puede enviar datos al servidor y el
servidor al browser. Para el dashboard de Roomly solo necesitamos una dirección:
**servidor → browser** (el backend avisa que llegó una reserva nueva).

**SSE** es exactamente eso: una conexión HTTP que el servidor mantiene abierta y
por la que pushea mensajes de texto cuando quiere. El browser lo implementa con la
API nativa `EventSource`.

Ventajas de SSE sobre WebSockets para este caso:
- Next.js App Router lo soporta nativamente con `ReadableStream` — sin librerías extra
- El browser reconecta automáticamente si la conexión se corta (comportamiento built-in del spec)
- Funciona sobre HTTP/1.1 y HTTP/2
- Cero infraestructura nueva

### Redis Pub/Sub

El proyecto ya tiene Redis corriendo para BullMQ. Redis tiene un sistema de
canales de mensajería nativo: **Pub/Sub**.

- **Publisher**: quien publica mensajes en un canal
- **Subscriber**: quien escucha ese canal y recibe los mensajes

En Roomly: el `reservation.service.ts` publica en el canal `roomly:dashboard`
cada vez que crea, modifica o cancela una reserva. El endpoint SSE está suscripto
a ese canal y reenvía cada mensaje al browser conectado.

---

## Arquitectura del flujo completo

```
WhatsApp
   │
   ▼
n8n → POST /api/v1/reservations/crear
              │
              ▼
   reservation.service.ts
              │
              ├─── prisma.reservation.create()  ──► PostgreSQL
              │
              ├─── reservationQueue.add()        ──► BullMQ (jobs async)
              │
              ├─── createCalendarEvent()         ──► Google Calendar
              │
              └─── redis.publish(                ──► Redis channel
                     "roomly:dashboard",               "roomly:dashboard"
                     { type: "NEW_RESERVATION", … }        │
                   )                                        │
                                                            ▼
                                             GET /api/dashboard/events
                                             (SSE route handler)
                                             └─ suscripto al channel
                                             └─ streamea "data:{…}\n\n"
                                                            │
                                                            ▼
                                                   browser (EventSource)
                                                   LiveUpdates.tsx
                                                   └─ router.refresh()
                                                            │
                                                            ▼
                                             Next.js re-corre los Server
                                             Components del dashboard
                                             └─ tabla de reservas actualizada
```

---

## Archivos involucrados

| Archivo | Rol |
|---------|-----|
| `lib/events.ts` | Tipo `DashboardEvent` y nombre del canal Redis |
| `lib/redis-subscriber.ts` | Factory que crea conexiones Redis dedicadas para sub |
| `services/reservation.service.ts` | Publica el evento tras cada operación |
| `app/api/dashboard/events/route.ts` | Endpoint SSE (suscriptor Redis → stream HTTP) |
| `components/dashboard/LiveUpdates.tsx` | Client component con `EventSource` + `router.refresh()` |
| `app/dashboard/layout.tsx` | Monta `<LiveUpdates />` una vez para todo el dashboard |

---

## Por qué hay dos clientes Redis distintos

```
lib/redis.ts             ← conexión compartida
                            usada por BullMQ, reservation.service, etc.
                            tiene maxRetriesPerRequest: null (requerido por BullMQ)

lib/redis-subscriber.ts  ← crea conexiones NUEVAS para pub/sub
                            una conexión suscripta no puede ejecutar comandos normales
                            (PUBLISH, GET, SET, etc.) — Redis lo prohíbe
```

Si se reutilizara la misma conexión para suscribirse y luego intentar hacer
`redis.publish()` o un query de BullMQ, Redis devolvería:
```
ERR_WRONG_TYPE: Command not allowed when connection is in subscriber mode
```

Cada llamada `GET /api/dashboard/events` crea su propio subscriber. Cuando el
browser cierra la pestaña, `req.signal` dispara el `abort` event y el subscriber
se desconecta limpiamente.

---

## router.refresh() — cómo se actualiza la UI

El dashboard usa **Server Components** de Next.js: la tabla de reservas es código
que corre en el servidor, hace el query a la DB y devuelve HTML. No tiene estado
en el browser.

Cuando `router.refresh()` se llama desde un Client Component:
1. Next.js hace un fetch al servidor para re-ejecutar todos los Server Components
   de la ruta actual
2. Los datos frescos de la DB reemplazan el HTML anterior
3. El browser muestra la tabla actualizada

Es la forma idiomática de Next.js App Router para refrescar datos del servidor
sin recargar la página completa.

---

## Eventos que se publican

```typescript
type DashboardEvent =
  | { type: "NEW_RESERVATION";      code: string; guestName: string; room: string }
  | { type: "RESERVATION_UPDATED";  code: string }
  | { type: "RESERVATION_CANCELLED"; code: string }
```

Actualmente los tres tipos disparan un `router.refresh()`. En el futuro se podría
usar el tipo para mostrar un toast distinto ("Nueva reserva RML-0042 de Juan García").

> **Cambio (2026-06-06):** el evento `NEW_RESERVATION` ahora envía el **titular por
> reserva**. En `reservation.service.ts` el `guestName` del evento se toma como
> `reservation.guestName ?? reservation.guest.name` (ver feature de titular por
> reserva en `BACKEND.md`). La **estructura de SSE no cambió**: mismos tipos, mismos
> archivos, mismo flujo.

> **La captura de chat NO usa SSE.** Los mensajes de WhatsApp se guardan vía el
> endpoint `POST /api/v1/conversations/log` (lo llama n8n) y el drawer "Ver chat"
> los **consulta on-demand** al abrirse (server action `getReservationChat`). No hay
> evento SSE por mensaje nuevo, así que el chat **no** se actualiza en vivo si lo
> tenés abierto. Si se quisiera, habría que agregar un tipo `NEW_MESSAGE` al
> `DashboardEvent` y publicarlo desde el endpoint de logging.

---

## Heartbeat

El endpoint envía un comentario SSE (`: ping\n\n`) cada 25 segundos. Los comentarios
no disparan el `onmessage` del browser, pero sí mantienen viva la conexión a través
de proxies y load balancers que cierran conexiones idle después de 30 s (comportamiento
común en nginx, Caddy y AWS ALB).

---

## Gotcha: HMR en desarrollo

En desarrollo con `npm run dev`, Next.js recarga los módulos con hot module
replacement. Si el servidor se reinicia, las conexiones `EventSource` activas
se cortan. El browser las reconecta automáticamente (~3 s según el spec), así
que en la práctica no se nota.

En producción (VPS con `npm run build && npm start`) no hay HMR y las conexiones
son estables.

---

## Limitaciones conocidas

| Limitación | Impacto | Solución si escala |
|------------|---------|-------------------|
| Una conexión Redis por tab del dashboard abierta | Bajo (uso interno, pocas tabs) | Pool de subscribers compartido |
| `router.refresh()` re-fetcha TODOS los server components de la ruta | Bajo (query simple) | Granularidad con React cache() |
| No funciona en serverless (Vercel free) — las funciones no tienen estado persistente | No aplica — proyecto en VPS | Usar Pusher o Ably si se migra a serverless |
