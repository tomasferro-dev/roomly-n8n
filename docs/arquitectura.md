# Roomly – Arquitectura del sistema

Todo el sistema es una sola aplicación Next.js. No hay servicios auxiliares que
levantar: ni n8n, ni Redis, ni ngrok, ni Docker. El stack anterior está
archivado en [`legacy/`](legacy/README.md), con la tabla de equivalencias de
dónde quedó cada pieza.

## Stack

| Componente | Tecnología |
|------------|------------|
| Aplicación (API, dashboard, agente, canal) | Next.js 16 + Prisma |
| Base de datos | PostgreSQL (Neon) |
| IA | Google Gemini Flash Lite |
| Canal | WhatsApp Cloud API |
| Pagos | Mercado Pago |
| Calendario | Google Calendar (espejo) |
| Hosting | Vercel |

## Estructura

```
roomly-n8n/
└── backend/
    ├── app/
    │   ├── dashboard/                    UI del dashboard
    │   └── api/
    │       ├── whatsapp/webhook/         entrada de mensajes de Meta
    │       ├── cron/expire-payments/     barrido cada 15 min
    │       ├── dashboard/pulse/          huella para el sondeo del dashboard
    │       └── v1/                       API REST
    ├── lib/
    │   ├── agent/
    │   │   ├── run.ts        loop de tool-calling con Gemini
    │   │   ├── tools.ts      las 5 herramientas
    │   │   ├── prompt.ts     system prompt por defecto
    │   │   ├── memory.ts     memoria conversacional desde la tabla Message
    │   │   ├── config.ts     BotConfig: prompt y modelo editables
    │   │   ├── trace.ts      persistencia de AgentRun
    │   │   └── types.ts
    │   ├── channels/whatsapp.ts   Graph API de Meta
    │   ├── dedup.ts               deduplicación de webhooks
    │   ├── calendar.ts, mercadopago.ts, prisma.ts, validations.ts
    │   ├── services/
    │   ├── prisma/schema.prisma
    │   ├── scripts/               bancos de prueba del agente
    │   └── vercel.json            declaración del cron
    └── docs/
```

## Flujo de un mensaje

```
1.  Meta hace POST a /api/whatsapp/webhook
2.  Se extrae el mensaje. Si no es texto (statuses, audio, imagen) → 200 y listo
3.  Se responde 200 en ~50 ms. Meta corta a los ~20 s
4.  after() toma el trabajo, ya con la respuesta enviada:
    a. Se reclama el message.id contra ProcessedEvent. Si Meta reintentó,
       se descarta acá
    b. Se cargan BotConfig y los últimos 10 intercambios de la tabla Message
    c. Corre el agente: Gemini decide qué herramientas llamar y se ejecutan
       en proceso, sin HTTP
    d. Se guarda un AgentRun con la traza completa
    e. Se envía la respuesta por la Graph API
    f. Se persiste el turno en Message, DESPUÉS de responder: es lo que lee
       la memoria en el mensaje siguiente
```

Si algo falla en cualquier punto de `after()`, el huésped recibe el mensaje de
disculpa y el `AgentRun` queda con `status: FAILED` y el error.

## Flujo de reserva con pago

```
1.  consultar_habitaciones → disponibilidad con precios
2.  El agente pregunta: ¿seña del 15% o pago total?
3.  crear_reserva:
    a. Reservation en PENDING_PAYMENT
    b. Preferencia en Mercado Pago
    c. Payment con expiresAt a 24 h
    d. Devuelve paymentUrl, payAmount, expiresAt, contacto del hotel
4.  El agente manda el link
5.  El huésped paga
6.  MP hace POST a /api/v1/payments/webhook
    a. Se deduplica contra ProcessedEvent
    b. after(): se consulta el pago contra la API de MP (no se confía en el
       cuerpo de la notificación), la reserva pasa a CONFIRMED, se agenda la
       limpieza y se avisa al huésped
7.  Si a las 24 h no se pagó, el cron cancela la reserva
```

`crear_reserva` es idempotente: si se la llama dos veces con los mismos datos,
devuelve la reserva que ya existe con su link original. El modelo a veces se
adelanta y la llama antes de que el huésped elija forma de pago, y volvía a
llamarla al recibir la respuesta; sin idempotencia la segunda chocaba contra la
primera y dejaba una reserva bloqueando la habitación.

## Trabajo diferido

No hay cola de jobs. Lo corto corre inline; lo diferido lo barre el cron.

| Tarea | Cuándo |
|---|---|
| Agendar limpieza | Inline, al confirmarse la reserva o el pago |
| Avisar pago acreditado | Inline, en el webhook de MP |
| Expirar reservas impagas | Cron, cada 15 min |
| Cancelar reservas huérfanas | Cron, cada 15 min |
| Purgar `ProcessedEvent` viejos | Cron, cada 15 min |

Una reserva **huérfana** es una que quedó en `PENDING_PAYMENT` sin fila de
`Payment`, porque la preferencia de Mercado Pago falló después de haberse
creado la reserva. Sin el barrido, bloquearía la habitación para siempre. El
cron respeta un margen de 30 minutos para no tocar una que se esté creando
justo en ese momento.

## Base de datos

Neon, región `sa-east-1` (São Paulo). La `DATABASE_URL` tiene que ser la
connection string **con pooling** — la que lleva `-pooler` en el host. La
directa abre una conexión por invocación y en serverless se agotan.

> **Neon deja el `search_path` vacío** en los proyectos nuevos. Prisma no se ve
> afectado porque califica el esquema por su cuenta, pero cualquier consulta
> suelta contra esta base tiene que escribir `public."Tabla"`, con las comillas.
> Sin calificar, da `relation "Hotel" does not exist` aunque la tabla exista.

Las consultas dejaron de ser instantáneas: contra el Postgres local una lectura
tardaba entre 4 y 30 ms, contra Neon entre 300 y 650 ms. No es un problema para
el bot, porque ya responde el 200 antes de procesar, pero sí conviene tenerlo en
cuenta al agregar consultas en serie dentro de una misma petición.

## Observabilidad

Cada mensaje entrante deja un `AgentRun` con el texto de entrada y de salida,
el estado, cada herramienta llamada con sus argumentos y su resultado, tokens,
iteraciones y duración. Es el reemplazo del historial de ejecuciones de n8n, y
al ser una tabla se puede consultar con SQL:

```sql
-- Herramientas que más fallan
SELECT step->>'name' AS herramienta, count(*)
FROM "AgentRun", jsonb_array_elements(steps) AS step
WHERE step->>'kind' = 'tool' AND (step->>'ok')::boolean = false
GROUP BY 1 ORDER BY 2 DESC;

-- Conversaciones que terminaron mal
SELECT phone, "inboundText", error, "createdAt"
FROM "AgentRun" WHERE status <> 'OK' ORDER BY "createdAt" DESC LIMIT 20;
```

## Dashboard

Se mantiene al día sondeando `/api/dashboard/pulse` cada 10 segundos, que
devuelve una huella barata del estado. El cliente sólo pide un refresh cuando
la huella cambia, y no consulta con la pestaña en segundo plano.

Antes esto era SSE sobre Redis pub/sub. En Vercel ese stream se corta al llegar
al `maxDuration` de la función y el dashboard se queda mudo sin avisar.

## Límites conocidos

- **Cuota de Gemini.** El tier gratuito son 15 requests por minuto y una
  reserva completa consume entre 6 y 8: el techo real es de unas dos
  conversaciones por minuto. Producción necesita tier pago.
- **Tokens de Meta.** Los temporales duran 24 horas. Hace falta un token de
  System User.
- **Ventana de 24 horas de WhatsApp.** Los mensajes que inicia el bot (el aviso
  de pago acreditado) sólo llegan si el huésped escribió en las últimas 24
  horas. Fuera de esa ventana hace falta una plantilla aprobada por Meta.
- **Autenticación de un solo admin**, en variables de entorno. Sin rotación ni
  recuperación de contraseña.
- **El webhook de Mercado Pago no valida firma.** El daño está acotado porque
  el pago se verifica contra la API de MP antes de confirmar nada, pero
  conviene validar el header `x-signature`.

## Checklist de producción

- [ ] `MP_ACCESS_TOKEN` productivo
- [ ] `NEXTAUTH_URL` con el dominio real (Mercado Pago lo usa para su webhook)
- [ ] `WHATSAPP_ACCESS_TOKEN` de System User, no temporal
- [ ] `WHATSAPP_VERIFY_TOKEN` definido y cargado también en el panel de Meta
- [ ] `AUTH_SECRET` nuevo (`openssl rand -base64 32`)
- [ ] `ADMIN_PASSWORD_HASH` con una contraseña real
- [ ] `CRON_SECRET` definido
- [ ] `GEMINI_API_KEY` con tier pago
- [ ] Webhook de Meta apuntando a `https://TU-DOMINIO/api/whatsapp/webhook`
- [ ] App de Meta en modo Live
- [ ] Plantilla de WhatsApp aprobada para avisos fuera de la ventana de 24 h
