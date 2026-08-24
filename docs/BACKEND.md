# Roomly – Backend MVP

Panel de administración y API REST para el sistema de reservas Roomly.

## Stack

| Capa | Tecnología |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) + TypeScript |
| ORM | Prisma 7 |
| Base de datos | PostgreSQL 16 |
| Cache / Queues | Redis 7 + BullMQ |
| Auth | NextAuth v5 (Credentials) |
| Validación | Zod 4 |
| UI | shadcn/ui + Tailwind CSS |
| Runtime | Node.js 20 |

> **Config Turbopack.** `next.config.ts` fija `turbopack.root = __dirname` para
> anclar la raíz del workspace a `backend/`. Sin eso, al haber otro `package-lock.json`
> en la carpeta padre, Turbopack inferiría mal la raíz y se quedaba sin memoria al
> compilar (ver `PROBLEMAS_Y_SOLUCIONES.md` [009]).

---

## Estructura del proyecto

```
backend/
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/route.ts   # Handlers NextAuth
│   │   ├── dashboard/pulse/route.ts      # huella para el sondeo del dashboard
│   │   └── v1/
│   │       ├── reservations/
│   │       │   ├── route.ts              # GET list / POST create
│   │       │   ├── [id]/route.ts         # GET / PATCH / DELETE by id o código RML
│   │       │   ├── crear/route.ts        # GET (variante para n8n)
│   │       │   ├── modificar/route.ts    # GET (variante para n8n)
│   │       │   └── cancelar/route.ts     # GET (variante para n8n)
│   │       ├── conversations/log/route.ts # POST — guarda el chat (lo llama n8n)
│   │       ├── rooms/route.ts            # GET list / POST create
│   │       ├── room-types/, rate-plans/  # CRUD config
│   │       ├── guests/route.ts           # GET list / POST upsert
│   │       └── hotels/route.ts           # GET list / POST create
│   ├── dashboard/
│   │   ├── layout.tsx                    # Navbar + auth guard + <LiveUpdates/>
│   │   ├── page.tsx                      # Lista de reservas + stats
│   │   ├── actions.ts                    # Server actions (editar titular, checkoutReservation, getReservationChat)
│   │   ├── rooms/page.tsx               # Grilla de habitaciones (ocupación de hoy)
│   │   └── configuracion/               # Autogestión del hotel (tipos, tarifas, habitaciones)
│   └── login/page.tsx                   # Formulario de login
├── components/dashboard/
│   ├── ReservationTable.tsx              # Tabla de reservas colapsable (client)
│   ├── ChatDrawer.tsx                    # Panel lateral con la conversación (client)
│   ├── EditableGuestCell.tsx             # Editar titular/contacto desde la tabla
│   ├── NavLink.tsx                       # Link de navbar con estado activo
│   ├── LiveUpdates.tsx                   # EventSource (SSE) + router.refresh()
│   ├── RoomGrid.tsx                     # Grilla por piso (client)
│   └── DeleteButton.tsx / SubmitButton.tsx
├── lib/
│   ├── prisma.ts                         # Prisma singleton
│   ├── redis.ts                          # Redis/ioredis singleton
│   ├── redis-subscriber.ts              # Conexiones Redis para SSE pub/sub
│   ├── events.ts                         # Tipo DashboardEvent + canal Redis
│   ├── queue.ts                          # BullMQ queues + worker
│   ├── calendar.ts                       # Google Calendar
│   └── validations.ts                   # Zod schemas
├── services/
│   ├── availability.service.ts          # Disponibilidad + grilla de habitaciones
│   ├── reservation.service.ts           # CRUD reservas + audit log + eventos
│   └── conversation.service.ts          # Log de chat + getReservationChat
├── prisma/
│   ├── schema.prisma                     # Modelo de datos
│   ├── seed.ts                           # Datos iniciales
│   └── migrations/                       # Historial SQL
├── auth.ts                               # Configuración NextAuth
├── middleware.ts                         # Protección de rutas (sesión o `_s`)
├── next.config.ts                        # output standalone + turbopack.root
├── Dockerfile                            # Multi-stage build
├── entrypoint.sh                         # migrate deploy + start
└── .env.example                          # Variables de entorno
```

---

## Modelo de datos

### Entidades principales

```
Hotel ──< RoomType ──< Room
      ──< RatePlan (por RoomType)
      ──< Guest ──< Reservation ──< HousekeepingTask
                                ──< AuditLog
```

| Modelo | Descripción |
|---|---|
| `Hotel` | Unidad de negocio. MVP: 1 hotel. |
| `RoomType` | Tipo de habitación (Standard, Suite, etc.) con amenities. |
| `Room` | Habitación física (`number`, `floor`, `status`). |
| `RatePlan` | Precio por noche para un tipo, en un rango de fechas. |
| `Guest` | Huésped identificado por `(hotelId, phone)` único. Es el **contacto** de WhatsApp (uno por teléfono). |
| `Reservation` | Reserva con código `RML-XXXX` único. `checkIn`/`checkOut` como `@db.Date`. Incluye **`guestName`** = titular **de esa reserva** (independiente del `Guest`). |
| `HousekeepingTask` | Tarea de limpieza (se crea automáticamente al hacer una reserva). |
| `ConversationSession` | Estado parcial de una conversación WhatsApp (contexto JSON). |
| `Message` | **Transcripción del chat** de WhatsApp (una fila por mensaje). Campos: `phone`, `guestId?`, `direction` (`INBOUND`/`OUTBOUND`), `content`, `waTimestamp?`, `createdAt`. |
| `AuditLog` | Historial de cambios por reserva (before/after JSON). |

> **Titular por reserva (`Reservation.guestName`).** El `Guest` es único por teléfono,
> así que su `name` no sirve para distinguir titulares cuando el mismo número reserva
> para personas distintas. Por eso cada reserva guarda su propio `guestName` (capturado
> al crearla). El dashboard muestra `reservation.guestName`. Ver `PROBLEMAS_Y_SOLUCIONES.md` [003].

### Prevención de double-booking

El esquema incluye una restricción PostgreSQL GIST que **impide físicamente** solapar reservas para la misma habitación:

```sql
-- Se agrega via migración manual (ver prisma/migrations/)
ALTER TABLE "Reservation"
ADD CONSTRAINT "no_double_booking"
EXCLUDE USING GIST (
  "roomId" WITH =,
  daterange("checkIn", "checkOut", '[)') WITH &&
) WHERE (status NOT IN ('CANCELLED', 'NO_SHOW'));
```

Esto requiere la extensión `btree_gist` de PostgreSQL.

La capa de servicio también hace una verificación previa en memoria (`availability.service.ts`) para dar un mensaje de error claro antes de que la DB rechace la operación.

---

## API REST

Todas las rutas bajo `/api/v1/` requieren autenticación (lo valida `middleware.ts`):
- **Sesión activa** (cookie de NextAuth) — para el dashboard
- **Header `X-N8N-Secret: <valor>`** *o* **query param `?_s=<valor>`** — para llamadas
  desde n8n (los tools y el nodo de logging usan `?_s=` porque van en la URL)

### Reservas

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/v1/reservations?hotelId=&status=&from=&to=&page=&pageSize=` | Lista paginada |
| `POST` | `/api/v1/reservations` | Crear reserva |
| `GET` | `/api/v1/reservations/:id` | Obtener por ID o código `RML-XXXX` |
| `PATCH` | `/api/v1/reservations/:id` | Modificar fechas, estado, habitación |
| `DELETE` | `/api/v1/reservations/:id` | Cancelar (soft delete) |

**Body para crear reserva (POST):**
```json
{
  "hotelId": "cuid...",
  "roomId": "cuid...",
  "guest": {
    "name": "Juan Pérez",
    "phone": "5492616649039"
  },
  "checkIn": "2026-06-01",
  "checkOut": "2026-06-05",
  "numGuests": 2,
  "channel": "WHATSAPP",
  "code": "RML-1234"
}
```

> El campo `code` es opcional. Si viene del flujo de n8n (donde ya se generó), se preserva. Si no, el backend genera uno único.

### Habitaciones

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/v1/rooms?hotelId=` | Todas las habitaciones |
| `GET` | `/api/v1/rooms?hotelId=&checkIn=&checkOut=` | Solo habitaciones disponibles (incluye `pricePerNight` y `ratePlanName`) |
| `POST` | `/api/v1/rooms` | Crear habitación |

### Huéspedes

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/v1/guests?hotelId=&phone=&name=` | Buscar huéspedes |
| `POST` | `/api/v1/guests` | Crear o actualizar huésped (upsert por teléfono) |

### Hoteles

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/v1/hotels` | Listar hoteles |
| `POST` | `/api/v1/hotels` | Crear hotel |

### Variantes GET para n8n

Los tools del agente de n8n envían todo por **GET** con query params (es como
`toolHttpRequest` arma las llamadas). Por eso, además del CRUD REST, existen:

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/v1/reservations/crear?...&guestName=&guestPhone=&...` | Crear reserva (n8n) |
| `GET` | `/api/v1/reservations/modificar?...&id=&checkIn=&...` | Modificar reserva (n8n) |
| `GET` | `/api/v1/reservations/cancelar?...&id=` | Cancelar reserva (n8n) |

### Conversaciones (chat)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/v1/conversations/log` | Guarda un turno del chat (lo llama el nodo "Logging" de n8n) |

**Body:** `{ phone, userMessage?, botMessage?, channel?, waTimestamp?, hotelId? }`
(al menos uno de los dos mensajes). Crea 1–2 filas `Message` (INBOUND/OUTBOUND).

---

## Autenticación

### Panel de administración

Se usa **NextAuth v5** con proveedor `Credentials`. No hay tabla de usuarios — las credenciales del admin viven en variables de entorno:

```env
ADMIN_EMAIL=admin@hotel.com
ADMIN_PASSWORD_HASH=$2b$10$...  # bcrypt hash
```

Para generar el hash:
```bash
node -e "const b=require('bcryptjs'); console.log(b.hashSync('tupassword', 10))"
```

### Integración con n8n

Las llamadas desde n8n usan un secreto compartido en el header HTTP:

```
X-N8N-Secret: <N8N_WEBHOOK_SECRET>
```

Configurar en n8n: en el nodo HTTP Request que llama al backend, agregar el header `X-N8N-Secret`.

---

## Colas asíncronas (BullMQ)

Al crear una reserva, se encolan automáticamente dos jobs:

| Job | Descripción |
|---|---|
| `SEND_CONFIRMATION` | Enviar confirmación por WhatsApp (TODO: conectar a WABA API) |
| `SCHEDULE_HOUSEKEEPING` | Crear tarea de limpieza para el día del check-out |

Los workers se definen en `lib/queue.ts`. En producción, corren en un proceso separado.

---

## Dashboard

Accesible en `http://localhost:3000/dashboard` (requiere login).

El **navbar** resalta la sección activa (`NavLink.tsx`, usa `usePathname`).

### Página de reservas (`/dashboard`)
- KPIs: check-ins de hoy, huéspedes activos, reservas confirmadas
- **Tabla colapsable.** Columnas visibles: Código, Huésped, Habitación, Check-in,
  Check-out, Estado. Ordenadas por **fecha de creación descendente** (más nuevas primero).
- **Badge "Checkout vencido"** (naranja) en reservas cuya fecha de checkout ya pasó
  y siguen con estado `CONFIRMED` o `CHECKED_IN`.
- Al hacer clic en una fila se **despliega** el detalle: Noches, Personas, Canal,
  Tarifa + precio/noche, Total estimado (precio × noches), Creada el,
  botón **"Cerrar reserva"** y botón **"Ver chat"**.
- **"Cerrar reserva"** cambia el estado a `CHECKED_OUT` y registra en el `AuditLog`.
  Solo aparece para reservas `CONFIRMED` o `CHECKED_IN`.
- El nombre del huésped es editable inline (`EditableGuestCell`): el **nombre** actualiza
  el titular de **esa** reserva (`reservation.guestName`); email/DNI van al `Guest`.
- **"Ver chat"** abre un panel lateral (`ChatDrawer`) con la conversación de esa reserva.

### Página de habitaciones (`/dashboard/rooms`)
- Grilla visual por piso
- Colores: verde (libre), rojo (ocupada), amarillo (mantenimiento)
- Cada tarjeta muestra tipo de habitación y **precio por noche** (tomado del `RatePlan` vigente)
- Muestra el nombre del huésped en habitaciones ocupadas
- **Ocupación de HOY** (ventana `hoy → mañana`): una habitación está "Ocupada" solo
  si hay alguien hospedado esta noche. (Antes usaba una ventana de 7 días — ver
  `PROBLEMAS_Y_SOLUCIONES.md` [006].)

### Configuración (`/dashboard/configuracion`)
Autogestión del hotel: tipos de habitación, tarifas y habitaciones (CRUD).

---

## Captura de chat (WhatsApp)

Toda la conversación de WhatsApp se **almacena** para poder reconstruir el chat y
usarlo después en mejoras del sistema.

**Flujo:**
1. n8n, tras responder al usuario, hace `POST /api/v1/conversations/log` con el
   mensaje del usuario y la respuesta del bot (nodo "Logging de interacción").
2. `conversation.service.ts → logInteraction()` guarda el **hilo completo por
   teléfono**: una fila `Message` INBOUND y otra OUTBOUND.
3. En el dashboard, "Ver chat" llama al server action `getReservationChat()` que
   devuelve **el chat de esa reserva**.

**Cómo se delimita el chat por reserva.** Como los mensajes llegan *antes* de que
exista la reserva, no se puede asociar 1:1 en el momento. Se guarda todo el hilo y
la vista por reserva se recorta usando el **código RML como marcador de fin de
conversación**: cada reserva confirma con su `RML-XXXX`, así que su chat va desde
**después** de la confirmación anterior y **hasta** su propia confirmación. Si no se
encuentra el mensaje de confirmación (reserva sin chat / creada desde el dashboard),
cae a una ventana temporal. Ver `PROBLEMAS_Y_SOLUCIONES.md` [010].

> El chat **no** se actualiza en vivo; el drawer lo consulta al abrirse. El
> resto del dashboard se mantiene al día sondeando `/api/dashboard/pulse`.

---

## Setup local

### 1. Requisitos
- Node.js 20+
- Docker Desktop (para postgres y redis)

### 2. Levantar servicios de infraestructura
```bash
# Desde la raíz del repo
docker compose up postgres redis -d
```

### 3. Configurar variables de entorno
```bash
cd backend
cp .env.example .env
# Editar .env con tus valores
```

### 4. Instalar dependencias y migrar
```bash
npm install
npm run db:migrate   # crea las tablas + aplica el EXCLUDE constraint
npm run db:seed      # carga hotel, tipos y habitaciones de ejemplo
```

### 5. Iniciar el servidor de desarrollo
```bash
npm run dev
# → http://localhost:3000
```

---

## Migración con EXCLUDE constraint

La migración inicial incluye un paso manual SQL para agregar la restricción de double-booking. Luego de correr `npx prisma migrate dev --name init`, editar el archivo SQL generado en `prisma/migrations/*/migration.sql` y agregar al final:

```sql
-- Habilitar extensión necesaria para GIST en columnas no geométricas
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Restricción de exclusión para prevenir solapamiento de reservas
ALTER TABLE "Reservation"
ADD CONSTRAINT "no_double_booking"
EXCLUDE USING GIST (
  "roomId" WITH =,
  daterange("checkIn"::date, "checkOut"::date, '[)') WITH &&
) WHERE (status NOT IN ('CANCELLED', 'NO_SHOW'));
```

---

## Deploy

Vercel, con `backend/` como root directory. Cada push despliega. Las
migraciones se aplican en el comando de build, no al arrancar el proceso.

El deploy en contenedor quedó archivado en `legacy/` (`Dockerfile.backend` y
`entrypoint.sh`) por si alguna vez hiciera falta volver.

---

## El agente

El bot vive dentro de este mismo backend, en `lib/agent/`. Las cinco
herramientas llaman a los services **en proceso**: no hay HTTP ni secreto
compartido de por medio.

Antes esto era un workflow de n8n que llamaba a `/api/v1/*` con
`?_s=N8N_WEBHOOK_SECRET`. Ese secreto ya no existe. Ver `arquitectura.md`, y
`legacy/README.md` para la equivalencia pieza por pieza.

---

## Variables de entorno

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | URL de PostgreSQL |
| `REDIS_URL` | URL de Redis |
| `AUTH_SECRET` | Secreto para firmar JWT (generar con `openssl rand -base64 32`) |
| `NEXTAUTH_URL` | URL pública del backend |
| `ADMIN_EMAIL` | Email del administrador |
| `ADMIN_PASSWORD_HASH` | Hash bcrypt de la contraseña |
| `N8N_WEBHOOK_SECRET` | Secreto compartido para requests desde n8n |
| `POSTGRES_USER` | Usuario de PostgreSQL (Docker) |
| `POSTGRES_PASSWORD` | Contraseña de PostgreSQL (Docker) |
| `POSTGRES_DB` | Nombre de la base de datos (Docker) |
