# Bitácora de Roomly

> **Si sos Claude y estás empezando una sesión: leé este archivo entero antes de
> tocar nada.** Es el estado del proyecto y el traspaso entre sesiones. Al
> terminar tu sesión, actualizalo: mové lo hecho a "Historial", agregá lo nuevo
> a "Pendientes", y anotá cualquier trampa que hayas encontrado.
>
> Este archivo **no se despliega**. Vive en el repo y en GitHub, nada más.

**Última actualización:** 2026-08-26
**Estado:** en producción y funcionando de punta a punta.

---

## 1. Qué es esto

Bot de WhatsApp que gestiona reservas de un hotel: consulta disponibilidad,
arma la reserva, cobra por Mercado Pago, confirma y avisa. Todo dentro de una
sola aplicación Next.js.

| | |
|---|---|
| **Producción** | https://roomly-n8n3.vercel.app |
| **Repo de trabajo** | `tomasferro-dev/roomly-n8n` (remoto `mine`), rama `master` |
| **Repo original** | `cubo1991/roomly-n8n` (remoto `origin`) — de un amigo del usuario |
| **Rama de trabajo** | `feat/agente-nativo-vercel`, que se pushea también a `master` de `mine` |
| **Base de datos** | Neon `sa-east-1`, con pooling |
| **Deploy** | Vercel Hobby, root directory `backend`, automático en cada push a `master` |

### Antes y ahora

El sistema era un workflow de n8n en Docker, expuesto con ngrok, que llamaba
por HTTP a un backend Next.js aparte. Se migró todo adentro del backend.

| Antes | Ahora |
|---|---|
| Nodo AI Agent + Gemini en n8n | `backend/lib/agent/run.ts` |
| 5 nodos `toolHttpRequest` | `backend/lib/agent/tools.ts`, llamadas en proceso |
| System message del nodo | `backend/lib/agent/prompt.ts` + tabla `BotConfig` |
| Nodo `memoryBufferWindow` (RAM) | `backend/lib/agent/memory.ts` (tabla `Message`) |
| Nodos webhook de Meta | `backend/app/api/whatsapp/webhook/route.ts` |
| Nodos `whatsApp` | `backend/lib/channels/whatsapp.ts` |
| Historial de ejecuciones de n8n | Tabla `AgentRun` |
| Worker de BullMQ + Redis | Inline + cron + barrido oportunista |
| SSE sobre Redis pub/sub | Sondeo de `/api/dashboard/pulse` |
| PostgreSQL en Docker | Neon |
| ngrok | Dominio de Vercel |

El stack viejo está archivado en `docs/legacy/`, no borrado, por si hiciera
falta volver. Ver `docs/legacy/README.md`.

### Documentación

- `README.md` — puesta en marcha y variables de entorno
- `docs/arquitectura.md` — cómo encaja todo, flujos, decisiones de diseño
- `docs/PRODUCCION.md` — **el más útil para operar**: qué se configura dónde,
  límites vigentes, y consultas SQL de diagnóstico
- `docs/BACKEND.md` — modelo de datos y endpoints
- `docs/mercadopago.md` — flujo de pago
- `docs/PROBLEMAS_Y_SOLUCIONES.md` — bitácora vieja, de la época de n8n

---

## 2. Estado actual — lo que YA FUNCIONA

Todo esto está verificado en producción, no asumido.

- **Bot de WhatsApp completo.** Recibe, entiende, consulta disponibilidad,
  crea la reserva, manda el link de pago, consulta, modifica y cancela.
- **Circuito de pago cerrado.** Verificado con `RML-1795`: pago `APPROVED`,
  reserva `CONFIRMED`, `mpPaymentId` guardado, aviso enviado.
- **Google Calendar.** Ya funcionaba desde antes de la migración. Las 24
  reservas de la base tienen su `calendarEventId`.
- **Dashboard** en `/dashboard`, con sondeo cada 10 s.
- **Cron diario + barrido oportunista** que expira reservas impagas y limpia
  huérfanas.
- **Deduplicación** de webhooks de WhatsApp y de Mercado Pago.
- **Trazas**: 31 `AgentRun` acumulados con el detalle de cada conversación.
- **Email con QR** (código escrito y desplegado, falta activarlo — ver §3).

### Estado de la base

```
reservas:  13 CANCELLED · 9 CONFIRMED · 2 PENDING_PAYMENT
pagos:      7 EXPIRED   · 3 APPROVED  · 2 PENDING
AgentRun:  31
```

### Verificación

```bash
cd backend
npm run agent:check              # lógica pura, sin base ni API key
npm run agent:tools              # las 5 herramientas contra la base (lectura)
npm run agent:tools -- --write   # + ciclo crear → modificar → cancelar
npm run agent:chat               # conversar con el bot sin WhatsApp
npx tsc --noEmit && npm run build
```

---

## 3. PENDIENTES DEL USUARIO (Tomás)

Nada de esto lo puede hacer Claude: son cuentas, paneles y trámites.

### Inmediato — para que el email funcione

- [ ] **Cargar `RESEND_API_KEY` en Vercel** y redeployar. Sin eso el email
      queda deshabilitado (el resto funciona igual).
- [ ] **Hacer una reserva de prueba dando un email** y avisarle a Claude para
      que verifique el envío contra la base.
- [ ] **Verificar un dominio en Resend** y cargar `EMAIL_FROM`. Sin dominio
      verificado, el único remitente es `onboarding@resend.dev`, que **sólo
      puede escribirle al dueño de la cuenta de Resend**. Alcanza para probar,
      no para huéspedes reales.

### Para abrir al público

- [ ] **Verificación del negocio en Meta.** El portfolio "AI Agent 2"
      (`1438610364573870`) figura sin verificar. Es trámite con documentación y
      tarda días.
- [ ] **Dar de alta un número propio** en la cuenta de WhatsApp Business. Son
      **dos cosas distintas**: el número de prueba `+1 555-145-1712` nunca sale
      de su lista blanca de 5 destinatarios, por más verificado que esté el
      negocio.
- [ ] **Tier pago de Gemini.** El gratuito son 15 requests/minuto y una reserva
      consume 6-8: el techo real son ~2 conversaciones por minuto. Pasado eso el
      bot se disculpa. El usuario decidió dejarlo para después.
- [ ] **Credenciales productivas de Mercado Pago**, cuando se quiera cobrar de
      verdad. Hoy están las de prueba.
- [ ] **Plantilla de WhatsApp aprobada por Meta**, para los avisos que inicia el
      bot fuera de la ventana de 24 h (el "pago acreditado" no llega si el
      huésped no escribió en las últimas 24 h).

### Higiene

- [ ] **Separar las variables de Vercel** entre Production y Preview. Hoy están
      todas en ambos, así que un deploy de preview escribiría sobre la base y
      las credenciales reales.
- [ ] **Limpiar el `.env` de la raíz** del repo, que todavía tiene variables
      muertas de n8n (`N8N_HOST`, `WEBHOOK_URL`, `BACKEND_URL`, `REDIS_URL`).
      Claude no puede tocar archivos `.env` por permisos.
- [ ] **Borrar `REDIS_URL` y `MP_WEBHOOK_SECRET` de Vercel.** La primera está
      muerta; la segunda todavía no se usa. **`N8N_WEBHOOK_SECRET` NO se borra**:
      el middleware la sigue usando para proteger `/api/v1/*`.
- [ ] **Decidir qué pasa con el repo del amigo.** Hoy el fork y el original son
      dos líneas separadas: los pushes de él no despliegan. Si el proyecto sigue
      siendo de los dos, lo sano es que él instale la app de Vercel en el repo
      original y volver a un solo lugar.

---

## 4. PENDIENTES DE CLAUDE

Trabajo de código, ordenado por lo que más aporta.

### Deuda técnica real

- [ ] **Validar la firma del webhook de Mercado Pago** (header `x-signature`,
      HMAC). Hoy el endpoint es público. El daño está acotado porque el pago se
      verifica contra la API de MP antes de confirmar nada, pero cualquiera
      puede hacer que el backend martille la API de MP.
- [ ] **Auth de un solo admin.** `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` en
      variables de entorno, sin rotación, sin recuperación, sin segundo usuario.
      Funciona y el hash es bcrypt, así que no es una vulnerabilidad — es deuda
      consciente. **Dominio CRÍTICO: no tocar sin aprobación explícita.**
- [ ] **Reintentar avisos de pago que fallaron.** Si el envío del WhatsApp o el
      email fallan, `notifiedAt` queda en null y nadie reintenta. El cron podría
      barrer los pagos `APPROVED` sin `notifiedAt`.

### Descartado a propósito

- **Renombrar `middleware.ts` → `proxy.ts`.** Next 16 lo deprecó y el build
  avisa en cada corrida. **Se decidió NO hacerlo**: silenciar un warning no
  justifica tocar el archivo que protege el dashboard. Hacerlo cuando toque
  actualizar Next. El codemod oficial
  (`npx @next/codemod@canary middleware-to-proxy .`) **no sirve acá**: reporta
  "0 ok" porque el archivo usa `export default auth(...)` de next-auth, patrón
  que su transformación AST no reconoce. Verificado en los docs locales que
  `proxy` acepta default export, así que sería sólo mover el archivo.

### Ideas no comprometidas

- Vista de `AgentRun` en el dashboard (hoy sólo por SQL).
- Editor del prompt en `/dashboard/configuracion/bot` — la tabla `BotConfig` ya
  existe y el agente ya la lee, falta la UI.
- Adjuntar un `.ics` al email de confirmación.

---

## 5. Trampas conocidas

Cosas que costaron horas. No repetirlas.

**El panel de webhooks de Meta miente.** Muestra lo que Meta *recibió de
WhatsApp*, no lo que *reenvió* al endpoint. Que aparezcan mensajes ahí no prueba
nada. La verdad está en `ProcessedEvent` y `AgentRun` de la base. Para aislar
"mi lado funciona" de "Meta no me llama": replicar el payload real con curl
contra producción, cambiando el `message.id` para esquivar la deduplicación.

**Si existe la fila `OUTBOUND` en `Message`, el envío por WhatsApp salió bien.**
`logInteraction` corre *después* de `enviarTexto`. Separa "falló el agente" de
"falló el envío" sin mirar logs.

**Neon deja el `search_path` vacío.** Toda consulta suelta necesita
`public."Tabla"` con comillas, o da `relation "Hotel" does not exist` con la
tabla existiendo. Prisma no se ve afectado.

**Nunca filtrar un dump de `pg_dump` por línea.** Un `grep "^INSERT INTO"`
truncó 16 INSERTs — justo los mensajes con saltos de línea. Lo peligroso: el
conteo de filas daba bien igual, así que una verificación por cantidad lo
hubiera dado por bueno. Verificar contenido, no cantidad.

**`pg_dump` emite meta-comandos de `psql`** (`\restrict`, `\unrestrict`). No son
SQL: hay que filtrarlos antes de ejecutar el dump por el protocolo normal.

**El escapado de comillas en Windows es un pozo.** Para `docker exec ... psql
-tAc "select ... from \"Tabla\""`, usar `execFileSync` con argumentos separados
en vez de una línea de shell. Sin shell, no hay nada que escapar. Lo mismo con
regex dentro de `node -e`: escribir un archivo, no pelear con el heredoc.

**Matar `next dev` a mitad corrompe `.next/dev/types/routes.d.ts`** y el build
siguiente falla con "Declaration or statement expected". Solución: `rm -rf .next`.

**No pipear un script largo a `| tail`**: bufferiza todo y parece colgado.

**Las credenciales de prueba de Mercado Pago ya NO se distinguen por el
prefijo** — las de prueba también empiezan con `APP_USR-`. Hay que mirar el
panel de MP.

**El hash de bcrypt se escribe distinto según dónde vaya**: en Vercel tal cual,
en `.env` con los `$` escapados como `\$` (dotenv-expand interpreta `$2b` como
variable). `auth.ts` deshace ese escape, así que ambos formatos funcionan.
`npm run admin:password` imprime los dos.

**Meta renombró secciones de su panel.** "Configuración de la API" ahora es
**WhatsApp → Inicio rápido → Prueba la API** (ahí está la lista blanca de
destinatarios). Los System Users están en **business.facebook.com/settings**, no
en el panel de la app. "Añadir socios" e "Invitar personas" de Business Suite NO
sirven para agregar destinatarios: dan acceso a los activos del negocio.

**Error de eslint preexistente** en `app/dashboard/rooms/page.tsx:11` ("Cannot
call impure function during render" por `Date.now`). Viene del commit `2e048b5`,
es un Server Component async, es falso positivo. No tocarlo.

---

## 6. Bugs encontrados y corregidos

Los cuatro primeros aparecieron sólo al desplegar. Todos silenciosos.

| Bug | Síntoma | Causa | Commit |
|---|---|---|---|
| Doble barra en `notification_url` | El huésped paga, MP cobra, la reserva nunca se confirma | `NEXTAUTH_URL` con `/` final → `//api/...` → 308. MP no sigue redirects en notificaciones | `ed1fa70` |
| `crear_reserva` duplicada | Reserva huérfana bloqueando la habitación | El modelo se adelanta y la llama antes de que el huésped elija forma de pago, y la vuelve a llamar al responder. No se arregla con prompt: es no determinismo, intermitente | `489f732` |
| Backoff inútil ante 429 | El bot se disculpa cuando podría haber esperado | Gemini manda `retryDelay` de 30-40 s; se reintentaba a los 600 ms | `489f732` |
| Markdown en WhatsApp | `**negrita**` literal en el chat | El modelo emitía Markdown; WhatsApp usa un asterisco | `489f732` |
| Fire-and-forget del webhook de MP | En Vercel, el pago quedaba a medio procesar | La función se congela al responder; faltaba `after()` | `8c122b8` |
| Reserva no atómica | Reserva sin `Payment`, bloqueando la habitación | `createReservation` y `createPaymentPreference` sin transacción | `8c122b8` (barrido de huérfanas) |
| Crear reserva dependía de Redis | Con Redis caído, fallaba el flujo principal | `createPaymentPreference` hacía `await queue.add(...)` | `8c122b8` |
| `tsx` sin declarar | "tsx no se reconoce" en cualquier máquina limpia | No estaba en `package.json`; `npx` lo bajaba al vuelo | `f90e0f1` |

---

## 7. Historial de sesiones

### Sesión 1 — 2026-08-22 al 2026-08-26

Migración completa de n8n a Vercel, en 6 fases, más el email con QR.

**Decisión de fondo:** el usuario frenó la primera propuesta ("no me esperaba
esta propuesta tan aniquiladora de n8n") y pidió el inventario honesto de lo que
se perdía. Tras leerlo eligió la **opción C**: internalizar el agente, pero
recuperando por diseño lo valioso de n8n — prompt editable en base (`BotConfig`)
y traza de ejecuciones propia (`AgentRun`).

| Fase | Qué | Commits |
|---|---|---|
| 1 | Agente nativo: tools, prompt, memoria, loop, trazas | `4aba34e` `4f74c38` `2c643fc` `489f732` |
| 2 | Canal de WhatsApp: webhook, dedup, ack rápido | `70c0179` |
| 3 | Sacar BullMQ y Redis; cron; arreglo del webhook de MP | `8c122b8` `12e8949` |
| 4 | Base a Neon, con verificación de integridad | `0a78d3e` |
| 5 | Deploy en Vercel | `f99efed` `904524e` `ec02b81` `f90e0f1` `ed1fa70` |
| 6 | Archivar el stack viejo, reescribir la documentación | `ea2fdab` `d852dd3` |
| — | Email de confirmación con QR vía Resend | `582de10` |

Se fueron del stack: Docker, ngrok, n8n, Redis, BullMQ. La raíz del repo pasó de
doce archivos a cuatro. Total: 60 archivos, +5386 líneas.

**Verificaciones hechas:** el ack a Meta tarda 53 ms (el límite son ~20 s); la
deduplicación aguanta 8 invocaciones concurrentes dejando pasar una; la
migración a Neon coincide fila por fila y en checksums de contenido; el agente
funciona con Redis apagado (antes fallaba); el circuito de pago cerró completo.

**Cambio de repo:** el original es de un amigo del usuario y Vercel no lo listaba
porque instalar su GitHub App requiere ser admin del repo, y el usuario es
colaborador. Se forkeó a `tomasferro-dev/roomly-n8n` y se despliega desde ahí.
La rama de trabajo se pushea a los dos remotos.

---

## 8. Cómo actualizar esta bitácora

Al cerrar cada sesión:

1. Agregar una entrada en **§7 Historial** con fecha, qué se hizo y los commits.
2. Mover lo completado fuera de **§3** y **§4**.
3. Agregar lo nuevo que quedó pendiente, **separando lo del usuario de lo de
   Claude** — el criterio es si Claude puede hacerlo solo o necesita una cuenta,
   un panel o una decisión.
4. Sumar a **§5 Trampas** cualquier cosa que haya costado más de lo razonable.
5. Sumar a **§6 Bugs** lo corregido, con su commit.
6. Actualizar la fecha del encabezado y el estado de la base en **§2**.
