# Roomly – Problemas y Soluciones

Registro de bugs encontrados durante el desarrollo y cómo se resolvieron.

> **Nota histórica.** Las entradas anteriores a la migración a Vercel describen
> el stack con n8n, Docker, ngrok y Redis, que ya no está en uso. Los comandos
> y rutas que mencionan (`docker compose`, `workflow.json`, URLs de ngrok,
> `/webhook/roomly-wa`) corresponden a ese sistema; quedan como registro de por
> qué se tomaron ciertas decisiones. Ver `legacy/README.md`.

## Notas de configuración

| Componente | Valor correcto | Notas |
|------------|---------------|-------|
| Modelo Gemini (n8n) | `models/gemini-3.1-flash-lite` | Los modelos `gemini-2.5-flash` y `gemini-1.5-flash` dan problemas: el primero tiene rate limit muy bajo en free tier (429), el segundo da 404. Usar siempre `models/gemini-3.1-flash-lite`. |

---

## [001] 401 Unauthorized – n8n no se conecta con el backend

**Fecha:** 2026-05-27  
**Síntoma:** El agente de IA respondía siempre con un error como "Uh, disculpá, hubo un problema al buscar habitaciones." Al revisar los logs de n8n, todos los tools HTTP devolvían `401 Unauthorized`.

### Causas (eran tres, todas juntas)

#### 1. `--env-file` faltante en Docker Compose
El archivo `Iniciar Roomly.bat` lanzaba Docker así:
```bat
docker compose -f "...\docker-compose.yml" up -d
```
Sin `--env-file` explícito, Docker Compose **no encontraba el `.env`** de la raíz del proyecto y el contenedor de n8n arrancaba con todas las variables de entorno vacías (`N8N_WEBHOOK_SECRET`, `HOTEL_ID`, `BACKEND_URL`, etc. = `""`).

**Verificación del problema:**
```powershell
docker exec n8nNgrok env | findstr N8N_WEBHOOK_SECRET
# → (sin output = variable vacía)
```

#### 2. Trailing slash en `N8N_WEBHOOK_SECRET`
En el `.env` raíz el valor era:
```
N8N_WEBHOOK_SECRET=roomly-n8n-secret-dev/   ← slash de más
```
Mientras que en `backend/.env`:
```
N8N_WEBHOOK_SECRET="roomly-n8n-secret-dev"  ← sin slash
```
El middleware comparaba `"roomly-n8n-secret-dev/"` contra `"roomly-n8n-secret-dev"` → siempre `false` → 401.

#### 3. Sin habitaciones en la base de datos
El `HOTEL_ID` en `.env` apuntaba a un hotel que existía en la DB pero sin habitaciones (`[]`). El agente consultaba disponibilidad, recibía un array vacío y no podía continuar el flujo.

### Solución

**Paso 1 – Quitar el trailing slash del `.env` raíz:**
```
# Antes
N8N_WEBHOOK_SECRET=roomly-n8n-secret-dev/

# Después
N8N_WEBHOOK_SECRET=roomly-n8n-secret-dev
```

**Paso 2 – Agregar `--env-file` al `.bat` y al comando de recreación:**
```bat
docker compose -f "C:\Users\David\roomly-n8n\docker-compose.yml" --env-file "C:\Users\David\roomly-n8n\.env" up -d
```

**Paso 3 – Recrear el contenedor n8n para que tome las variables:**
```powershell
docker compose -f "C:\Users\David\roomly-n8n\docker-compose.yml" --env-file "C:\Users\David\roomly-n8n\.env" up -d --force-recreate n8n
```

**Paso 4 – Correr el seed para crear habitaciones:**
```powershell
cd C:\Users\David\roomly-n8n\backend
npx tsx prisma/seed.ts
# → crea hotel, 2 tipos de habitación, 7 habitaciones, rate plans
```

**Paso 5 – Actualizar `HOTEL_ID` con el ID real que devolvió el seed:**
```
# .env raíz
HOTEL_ID=cmpnag0cv00001g3ccv957sed
```
Y recrear n8n nuevamente para que tome el nuevo `HOTEL_ID`.

### Verificación final
```powershell
# Variables dentro del contenedor
docker exec n8nNgrok env | grep -E "HOTEL_ID|N8N_WEBHOOK_SECRET"
# HOTEL_ID=cmpnag0cv00001g3ccv957sed
# N8N_WEBHOOK_SECRET=roomly-n8n-secret-dev

# Endpoint de habitaciones (desde fuera del contenedor)
curl "http://localhost:3000/api/v1/rooms?hotelId=cmpnag0cv00001g3ccv957sed&_s=roomly-n8n-secret-dev&checkIn=2026-06-10&checkOut=2026-06-12"
# → devuelve array con 7 habitaciones ✅

# Crear reserva de prueba
curl "http://localhost:3000/api/v1/reservations/crear?hotelId=...&_s=roomly-n8n-secret-dev&roomId=...&guestName=Test&..."
# → {"code":"RML-XXXX","status":"CONFIRMED",...} ✅
```

### Lección aprendida
> Siempre pasar `--env-file` explícito en Docker Compose cuando el `.env` no está en el directorio de trabajo desde donde se ejecuta el comando. No asumir que Docker lo encuentra solo.

---

## [002] WhatsApp webhook no recibe mensajes – hub.challenge falla

**Fecha:** 2026-05-27  
**Síntoma:** Los mensajes de WhatsApp no llegaban al bot. Meta Developer Console mostraba el error `(#2201) response does not match challenge, expected value="XXXXXXX"` al intentar verificar el webhook.

### Causas (encadenadas)

#### 1. Webhook no registrado en el runtime de n8n tras recrear el contenedor
Después de un `--force-recreate` del contenedor, n8n mostraba el workflow como "Published" en la UI pero internamente el webhook no estaba registrado. Los logs mostraban:
```
Received request for unknown webhook: "a3989a6b-2aa1-441d-8ef6-c91e5954738f/webhook" is not registered.
```
Hacer toggle Unpublish → Publish no alcanzaba porque la activación fallaba antes de registrar el webhook local.

#### 2. Suscripción de Meta en conflicto
Cuando n8n intentaba activar el WhatsApp Trigger, llamaba a la Meta Graph API para crear la suscripción. Meta respondía:
```
The WhatsApp App ID 1275991001111185 already has a webhook subscription.
```
Esto hacía que la activación fallara silenciosamente y el webhook nunca se registraba.

#### 3. El nodo WhatsApp Trigger no responde al hub.challenge
El nodo `whatsAppTrigger` de n8n no maneja correctamente la verificación GET de Meta. En lugar de devolver el valor de `hub.challenge`, respondía:
```json
{"message": "Webhook call received"}
```
Meta requiere que la respuesta sea **exactamente** el valor de `hub.challenge` como texto plano.

#### 4. n8n no enruta GET a webhooks con método "ALL"
Al reemplazar el WhatsApp Trigger con un Webhook genérico configurado como `httpMethod: "ALL"`, n8n tampoco respondía a GET:
```
This webhook is not registered for GET requests. Did you mean to make a ALL request?
```

### Solución definitiva

**Reemplazar el WhatsApp Trigger con dos nodos Webhook separados** en el mismo path (`roomly-wa`), uno para GET y otro para POST.

**Workflow v14 – estructura:**
```
GET  /webhook/roomly-wa  →  Responder challenge (devuelve hub.challenge como texto)
POST /webhook/roomly-wa  →  Ack 200  →  Extraer datos  →  AI Agent  →  Enviar WhatsApp  →  Log
```

**Nodo GET (verificación):**
```json
{
  "httpMethod": "GET",
  "path": "roomly-wa",
  "responseMode": "responseNode"
}
```
Conectado a un nodo "Respond to Webhook" que devuelve:
```
={{ ($json.query?.hub?.challenge) ?? ($json.query?.['hub.challenge']) ?? '' }}
```

**Nodo POST (mensajes reales):**
```json
{
  "httpMethod": "POST",
  "path": "roomly-wa",
  "responseMode": "responseNode"
}
```
Conectado a un nodo "Respond to Webhook" que devuelve `OK` inmediatamente, y luego continúa el flujo de procesamiento.

**Extracción del mensaje** actualizada para el formato nativo de Meta (el Webhook genérico no desenvuelve el payload como lo hacía el WhatsApp Trigger):
```javascript
const raw = $input.first().json;
const item = (raw.body && raw.body.entry) ? raw.body : raw;
const value = item.entry?.[0]?.changes?.[0]?.value;
// ... resto del parsing
```

**Pasos para aplicar:**
1. Borrar el workflow viejo en n8n
2. Importar `workflow.json` (v14)
3. Reasignar credenciales (WhatsApp + Gemini) en los nodos que las necesitan
4. Activar (Published)
5. En Meta Developer Console → WhatsApp → Configuration → Verificar y guardar:
   - **Callback URL:** `https://<ngrok-url>/webhook/roomly-wa`
   - **Verify Token:** `roomly2026`
6. **⚠️ Paso que se olvida fácil:** Después de verificar, en la misma sección buscar **"Webhook fields"** → buscar **"messages"** → click en **"Subscribe"**. Sin este paso Meta NO envía los mensajes aunque el webhook esté verificado.

**Para eliminar la suscripción vieja de Meta** (si aparece el error "already has a webhook subscription"):
```
Meta Graph API Explorer → App Token → DELETE
/1275991001111185/subscriptions?object=whatsapp_business_account
→ {"success": true}
```

### Verificación
```bash
curl "https://<ngrok-url>/webhook/roomly-wa?hub.mode=subscribe&hub.verify_token=roomly2026&hub.challenge=TEST123"
# → TEST123   (HTTP 200) ✅
```

### Lección aprendida
> El nodo `whatsAppTrigger` de n8n no implementa correctamente la respuesta al `hub.challenge` de Meta. Para proyectos propios, usar dos nodos `webhook` separados (GET + POST) en el mismo path es más confiable y transparente. El GET maneja la verificación y el POST los mensajes reales.

---

## [003] Nombre del huésped se pisa entre reservas del mismo teléfono

**Fecha:** 2026-05-27  
**Síntoma:** Al crear una nueva reserva con un teléfono que ya tenía reservas anteriores, el nombre que se enviaba en la nueva reserva sobreescribía el nombre en **todas** las reservas previas del mismo huésped.

### Causa

En `reservation.service.ts`, el upsert del huésped incluía `name` en el bloque `update`:

```typescript
const guestRecord = await prisma.guest.upsert({
  where: { hotelId_phone: { hotelId, phone: guest.phone } },
  update: { name: guest.name, email: ..., dni: ... }, // ← pisaba el nombre
  create: { ... },
});
```

El modelo de datos tiene **un registro `Guest` por teléfono**, y todas las reservas de ese huésped apuntan al mismo `guestId`. Al actualizar el nombre del `Guest`, el cambio se reflejaba en todo el historial.

### Solución

Quitar `name` del bloque `update`. El nombre se registra solo al **crear** el huésped (primera reserva). Las siguientes reservas con el mismo teléfono reutilizan el nombre ya guardado.

```typescript
update: { email: guest.email ?? undefined, dni: guest.dni ?? undefined },
```

`email` y `dni` sí se permiten actualizar porque son datos corregibles que no afectan el historial visible.

### Archivo modificado
`backend/services/reservation.service.ts`

### 🔄 Actualización (2026-06-06) — esta solución se reemplazó

El parche de no actualizar el `name` tenía un efecto colateral: como **todas** las
reservas de un teléfono comparten el mismo `Guest`, **todas** mostraban el primer
nombre registrado. Si el mismo número reservaba a nombre de personas distintas, no
había forma de ver el titular real de cada reserva.

**Solución definitiva:** guardar el titular **en la reserva**, no en el huésped.
Se agregó `Reservation.guestName` (migración `add_reservation_guest_name`, con
backfill desde `Guest.name`). `createReservation` lo persiste; el dashboard muestra
`reservation.guestName`; la edición en la tabla actualiza el titular de **esa**
reserva (email/DNI siguen en el `Guest`, que es el contacto de WhatsApp). El `Guest`
queda como contacto único por teléfono; el titular es por reserva.

---

## [004] `crear_reserva` falla tras agregar `guestName` (cliente Prisma desactualizado)

**Fecha:** 2026-06-06
**Síntoma:** Después de traer los cambios de `guestName`, el bot respondía "hubo un
error al crear la reserva" para **cualquier** habitación. El endpoint devolvía 500.

### Causa
La **base** ya tenía la columna `guestName` (migración aplicada), pero el **cliente
Prisma generado** en el clon donde corre la app no la conocía todavía. `prisma.reservation.create({ data: { guestName } })`
lanzaba *"Unknown argument `guestName`"*.

### Solución
Regenerar el cliente y reiniciar el dev server (Next cachea el cliente en memoria):
```bash
cd backend
npx prisma generate     # o npm install (postinstall corre prisma generate)
# reiniciar npm run dev
```
> **Lección:** tras tocar el `schema.prisma`, siempre `prisma generate` + reiniciar.
> La migración (base) y el cliente generado (código) son dos pasos distintos.

---

## [005] Tipografía "Times New Roman" en el dashboard

**Fecha:** 2026-06-06
**Síntoma:** El dashboard se veía con una fuente serif tipo Times New Roman.

### Causa
`layout.tsx` cargaba la fuente **Geist** en la variable `--font-geist-sans`, pero
el tema en `app/globals.css` aplicaba `html { @apply font-sans }` con
`--font-sans: var(--font-sans)` — una **auto-referencia vacía**. Al quedar sin
valor, el navegador caía al serif por defecto.

### Solución
Mapear `--font-sans` (y `--font-heading`) a la fuente ya cargada:
```css
--font-sans: var(--font-geist-sans);
--font-heading: var(--font-geist-sans);
```
**Archivo:** `backend/app/globals.css`

---

## [006] El panel de habitaciones marca "ocupada" una reserva futura

**Fecha:** 2026-06-06
**Síntoma:** Una habitación con una reserva que empieza dentro de unos días aparecía
"Ocupada" **hoy**, aunque no hubiera nadie hospedado.

### Causa
`app/dashboard/rooms/page.tsx` calculaba el estado sobre una ventana de **7 días**
(`hoy → hoy+7`) pero lo etiquetaba como "Estado actual". Cualquier reserva dentro
de esa ventana marcaba la habitación como ocupada.

### Solución
Ventana de **hoy → mañana**: "Ocupada" = hay alguien hospedado esta noche
(`check-in ≤ hoy < check-out`). El estado manual (`MAINTENANCE`/`OUT_OF_ORDER`)
se respeta como fallback.
**Archivo:** `backend/app/dashboard/rooms/page.tsx`

---

## [007] El bot dejó de responder — token de WhatsApp expirado

**Fecha:** 2026-06-06
**Síntoma:** Mandar "hola" al bot no devolvía nada (ni siquiera el mensaje de error).

### Diagnóstico
Leyendo los datos de ejecución de n8n (SQLite, tabla `execution_data`), el flujo
corría **entero** y fallaba en el último nodo:
```
lastNodeExecuted: "Enviar respuesta al usuario1"
Error: "Authorization failed - please check your credentials"
```
O sea: recibía el mensaje, Gemini respondía, pero **no podía enviar** el WhatsApp.
La línea de tiempo (éxitos hasta cierta hora, errores después) confirmó un **token
expirado**.

> **Cómo inspeccionar ejecuciones de n8n sin API key** (SQLite por defecto):
> ```bash
> docker exec n8nNgrok node -e "const P='/usr/local/lib/node_modules/n8n/node_modules/.pnpm/';\
> const s=require(P+'sqlite3@5.1.7/node_modules/sqlite3');const f=require(P+'flatted@3.4.2/node_modules/flatted');\
> const db=new s.Database('/home/node/.n8n/database.sqlite',s.OPEN_READONLY);\
> db.all('SELECT id,status FROM execution_entity ORDER BY startedAt DESC LIMIT 5',(e,r)=>{console.log(r);db.close();});"
> ```

### Solución
Renovar el token de acceso de WhatsApp en la credencial de n8n.
> **⚠️ El token de "API Setup" es temporal y expira a las 24 h.** Para evitar que el
> bot se caiga a diario, generar un **token permanente de System User** (Meta Business
> Settings → System Users) con permisos `whatsapp_business_messaging` +
> `whatsapp_business_management`. *(Actualmente se usa el temporal.)*

---

## [008] "Recipient phone number not in allowed list" — quirk del 9 (Argentina)

**Fecha:** 2026-06-06
**Síntoma:** Con el token ya válido, el envío seguía fallando:
```
Error: "Bad request - please check your parameters"
Detalle: "Recipient phone number not in allowed list" (HTTP 400)
```
enviando a `5492616628554`.

### Causa
WhatsApp **entrega** los mensajes entrantes con el `9` de móvil (`549…`), pero la
Cloud API espera el número **canónico sin el `9`** (`54…`) para **enviar**. Por eso
en la lista de destinatarios de Meta el número aparecía **sin el 9** por defecto.
Mandar al `549…` nunca matchea, sin importar cuántas variantes se agreguen.

### Solución
Normalizar el destinatario en los **dos** nodos de WhatsApp antes de enviar:
```
{{ $('Extraer datos del mensaje1').item.json.from.replace(/^549/, '54') }}
```
No se toca el número usado para huésped/memoria/log (sigue con `9`, consistente con
los datos existentes). En el repo: `workflow.json` (nodos `Enviar respuesta` /
`Enviar error`).
> **Lección:** para AR, enviar al número **sin el 9**, aunque el `from` venga con él.

---

## [009] Dev server sin memoria al compilar `/dashboard` (OOM Turbopack)

**Fecha:** 2026-06-06
**Síntoma:** `npm run dev` crasheaba al compilar `/dashboard`:
```
Fatal JavaScript out of memory: MemoryChunk allocation failed during deserialization
```
Antes del crash, el warning: *"multiple lockfiles ... selected the directory of
...\roomly-n8n as the root directory"*.

### Causa
Había **dos `package-lock.json`** (uno en la carpeta padre y otro en `backend/`).
Turbopack infería la **raíz del workspace** en el padre y escaneaba/cacheaba un
árbol enorme → OOM al deserializar la caché.

### Solución
Fijar la raíz a `backend` en `next.config.ts`:
```ts
turbopack: { root: __dirname }
```
y **borrar la caché vieja** (`.next/`), que se había generado con la raíz mal.
**Archivo:** `backend/next.config.ts`

---

## [010] El "Ver chat" mostraba la confirmación de la reserva anterior

**Fecha:** 2026-06-06
**Síntoma:** Al abrir el chat de una reserva aparecía, al principio, el último mensaje
de la reserva **anterior** (con su código RML y el nombre del titular).

### Causa
La primera versión de `getReservationChat` recortaba por **ventana temporal**. Como
el mensaje de confirmación se loguea unos segundos **después** de crearse la reserva,
caía en la ventana de la reserva siguiente.

### Solución
Delimitar por el **código RML**: cada reserva confirma con su `RML-XXXX`, que marca
el fin de una conversación. El chat de una reserva va desde **después** de la
confirmación anterior y **hasta** su propia confirmación (inclusive). Determinístico.
Fallback a ventana temporal si no hay mensaje de confirmación (reservas sin chat /
creadas desde el dashboard).
**Archivo:** `backend/services/conversation.service.ts`

---

*Más problemas se irán agregando a este archivo.*
