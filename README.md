# Roomly – Asistente de reservas por WhatsApp

Bot de WhatsApp que gestiona reservas de hotel: consulta disponibilidad, arma la
reserva, cobra por Mercado Pago y confirma. Todo corre dentro de una única
aplicación Next.js.

**En producción:** https://roomly-n8n3.vercel.app — ver
[`docs/PRODUCCION.md`](docs/PRODUCCION.md) para el estado del despliegue, los
límites actuales y cómo diagnosticar problemas.

## Stack

| Componente | Tecnología | Rol |
|------------|-----------|-----|
| **Aplicación** | Next.js 16 + Prisma | API, dashboard, agente y canal de WhatsApp |
| **Base de datos** | PostgreSQL (Neon) | Fuente de verdad |
| **IA** | Google Gemini Flash Lite | Entiende al huésped y decide qué herramienta usar |
| **Canal** | WhatsApp Cloud API | Comunicación con el huésped |
| **Pagos** | Mercado Pago | Seña del 15% o pago total |
| **Calendario** | Google Calendar | Espejo visual de reservas (no es fuente de verdad) |
| **Hosting** | Vercel | Deploy en cada push |

No hay Docker, ni ngrok, ni n8n, ni Redis. El stack anterior está archivado en
[`docs/legacy/`](docs/legacy/README.md).

## Arquitectura

```
WhatsApp
   │  POST
   ▼
/api/whatsapp/webhook ──► responde 200 en ~50 ms
   │                       (Meta corta a los ~20 s)
   └─ after() ──► agente Gemini
                    ├── consultar_habitaciones ──┐
                    ├── crear_reserva            │
                    ├── consultar_reserva        ├──► services ──► PostgreSQL
                    ├── modificar_reserva        │                     │
                    └── cancelar_reserva ────────┘                     ▼
                                                             Google Calendar
                                                                 (espejo)
```

Las herramientas del agente son llamadas a función directas contra los services,
no HTTP.

Las reservas que quedan sin pagar pasadas las 24 horas se cancelan solas: un
barrido oportunista que se dispara con el tráfico (máximo uno cada 15 minutos)
más un cron diario que cubre los días sin actividad. Ver
[`docs/arquitectura.md`](docs/arquitectura.md).

## Funcionalidades

- **Nueva reserva** – consulta disponibilidad con precios, arma la reserva y
  manda el link de pago. La reserva queda en `PENDING_PAYMENT` hasta que
  Mercado Pago acredite.
- **Confirmación por email** – al acreditarse el pago, si el huésped dejó un
  correo, recibe la confirmación con un QR del código `RML-XXXX` para mostrar
  al llegar. Es opcional: sin email la reserva funciona igual.
- **Google Calendar** – cada reserva crea su evento; se actualiza al modificar
  y se borra al cancelar.
- **Consulta, modificación y cancelación** – por código `RML-XXXX`. Cancelar
  exige confirmación explícita del huésped.
- **Memoria conversacional** – los últimos 10 intercambios por teléfono, desde
  la base, así sobreviven a cualquier reinicio.
- **Traza de ejecución** – cada mensaje deja un `AgentRun` con las herramientas
  llamadas, sus argumentos y resultados, tokens y duración.
- **Prompt editable** – el system prompt vive en `BotConfig` y se puede cambiar
  sin redeploy.
- **Dashboard** – reservas, habitaciones, tipos y tarifas.

## Desarrollo local

### Requisitos

- Node.js 20+
- Una base PostgreSQL (Neon sirve; también un Postgres local)
- API key de Google Gemini ([AI Studio](https://aistudio.google.com/apikey))
- Cuenta de WhatsApp Business API (Meta Developers)
- Credenciales de Mercado Pago

### Puesta en marcha

```bash
git clone https://github.com/tomasferro-dev/roomly-n8n.git
cd roomly-n8n/backend
npm install
cp .env.example .env    # completá los valores
npx prisma migrate deploy
npm run db:seed         # hotel, habitaciones y tarifas de ejemplo
npm run dev             # http://localhost:3000
```

### Variables de entorno

Van todas en `backend/.env`. En producción, en el panel de Vercel.

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | PostgreSQL. En Neon, usá la connection string **con pooling** |
| `AUTH_SECRET` | Firma de sesión de NextAuth |
| `NEXTAUTH_URL` | URL pública. Mercado Pago la usa para su webhook |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` | Acceso al dashboard (hash bcrypt) |
| `GEMINI_API_KEY` | Google AI Studio. 39 caracteres, empieza con `AIza` |
| `WHATSAPP_ACCESS_TOKEN` | Token de **System User** de Meta (los temporales duran 24 h) |
| `WHATSAPP_PHONE_NUMBER_ID` | Número del hotel, para los avisos que inicia el bot |
| `WHATSAPP_VERIFY_TOKEN` | Cadena que elegís vos; la misma va en el panel de Meta |
| `WHATSAPP_API_VERSION` | Opcional, por defecto `v22.0` |
| `RESEND_API_KEY` | Resend. Si falta, el email queda deshabilitado y todo lo demás sigue igual |
| `EMAIL_FROM` | Remitente, ej. `Roomly <reservas@tudominio.com>`. Requiere dominio verificado en Resend |
| `MP_ACCESS_TOKEN` | Mercado Pago. Las credenciales de prueba y las productivas ya **no** se distinguen por el prefijo: ambas empiezan con `APP_USR-` |
| `CRON_SECRET` | Protege el endpoint del cron |
| `HOTEL_ID` | Opcional. Si falta, se usa el único hotel de la base |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google Calendar |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Ojo con los `\n` al pegarla |
| `GOOGLE_CALENDAR_ID` | Google Calendar |

## Probar el bot sin WhatsApp

```bash
npm run agent:chat                          # conversación interactiva
npm run agent:chat -- --guion todos --pasos # los guiones, mostrando herramientas
```

La conversación vive en memoria y no toca la tabla `Message`. Las reservas que
se creen **sí son reales**: corré esto contra desarrollo.

## Cambiar la contraseña del dashboard

```bash
npm run admin:password
```

Pide la contraseña por teclado (no queda en el historial del shell) e imprime
el hash en los dos formatos que hacen falta:

- **Vercel** — el hash tal cual.
- **`backend/.env`** — con los `$` escapados como `\$`. Sin escapar,
  dotenv-expand interpreta `$2b` como una variable y se come parte del hash.
  `auth.ts` deshace ese escape al leerlo, así que ambos formatos funcionan.

Después de cambiarla en Vercel hay que redeployar: las variables no se aplican
al deploy que ya está hecho.

## Verificación

```bash
npm run agent:check          # lógica pura: zona horaria, prompt, parseo de Meta
npm run agent:tools          # las 5 herramientas contra la base (solo lectura)
npm run agent:tools -- --write   # agrega crear → modificar → cancelar
npx tsc --noEmit
npm run build
```

## Deploy

Vercel, con `backend/` como **root directory** del proyecto. Cada push despliega.

El build lo maneja el script `vercel-build` de `package.json`, que Vercel usa
automáticamente. Las migraciones corren **sólo en producción**: si un deploy de
preview trae una migración nueva, aplicarla tocaría la base de producción antes
de que ese cambio esté aprobado.

El cron está declarado en [`backend/vercel.json`](backend/vercel.json).

Después del primer deploy hay que apuntar dos webhooks al dominio de Vercel:

- **Meta Developers** → `https://TU-DOMINIO/api/whatsapp/webhook`, con el
  `WHATSAPP_VERIFY_TOKEN` que hayas elegido.
- **Mercado Pago** → se configura solo, a partir de `NEXTAUTH_URL`.

## Documentación

- [`docs/arquitectura.md`](docs/arquitectura.md) – cómo encaja todo
- [`docs/BACKEND.md`](docs/BACKEND.md) – modelo de datos y endpoints
- [`docs/mercadopago.md`](docs/mercadopago.md) – flujo de pago
- [`docs/PROBLEMAS_Y_SOLUCIONES.md`](docs/PROBLEMAS_Y_SOLUCIONES.md) – bitácora
- [`docs/PRODUCCION.md`](docs/PRODUCCION.md) – estado del despliegue y diagnóstico
- [`docs/legacy/`](docs/legacy/README.md) – el stack anterior con n8n
