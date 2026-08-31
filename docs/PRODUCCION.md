# Roomly en producción

Estado del sistema desplegado, y qué hacer cuando algo no anda.

| | |
|---|---|
| **URL** | https://roomly-n8n3.vercel.app |
| **Hosting** | Vercel, plan Hobby. Root directory: `backend` |
| **Base de datos** | Neon, `sa-east-1` (São Paulo), con pooling |
| **Repositorio** | `tomasferro-dev/roomly-n8n`, rama `master` |
| **Deploy** | Automático en cada push a `master` |

El dashboard está en `/dashboard`; la raíz redirige ahí. El acceso es un único
admin definido por `ADMIN_EMAIL` y `ADMIN_PASSWORD_HASH`.

## Qué se configura fuera del repo

Tres paneles, y ninguno está versionado. Si algo deja de andar de un día para
el otro sin que nadie haya tocado código, el problema está en alguno de estos.

### Vercel — variables de entorno

Las 16 que lee el código están en Settings → Environment Variables. Dos cosas
que se olvidan siempre:

- **Cambiar una variable no afecta al deploy que ya está corriendo.** Hay que
  redeployar.
- `NEXTAUTH_URL` tiene que ser el dominio real. Mercado Pago lo usa para armar
  su `notification_url`; si está mal, los pagos se cobran pero las reservas
  nunca se confirman.

### Meta — webhook de WhatsApp

En `developers.facebook.com` → app **n8n hotel 1** → WhatsApp:

| Campo | Valor |
|---|---|
| URL de devolución de llamada | `https://roomly-n8n3.vercel.app/api/whatsapp/webhook` |
| Token de verificación | el de `WHATSAPP_VERIFY_TOKEN` |
| Campos suscritos | `messages` |

**La suscripción a `messages` es un paso aparte** de guardar la URL, en el botón
"Administrar" de esa misma sección. Sin ella el webhook queda verificado, todo
parece correcto, y no llega ni un mensaje. No da ningún síntoma de error.

### Resend — emails

El email de confirmación con el QR sale cuando se acredita el pago, y sólo si
el huésped dejó un correo. Es un canal secundario: si Resend no está
configurado o el envío falla, la reserva se confirma igual y el aviso por
WhatsApp sale como siempre. Nada del flujo depende del email.

**Resend exige un dominio verificado** para usar una dirección propia en
`EMAIL_FROM`. Sin verificar, el único remitente disponible es
`onboarding@resend.dev`, y ése **sólo puede escribirle al dueño de la cuenta de
Resend**. Es la misma clase de límite que la lista blanca del número de prueba
de Meta: alcanza para probar, no para huéspedes reales.

### Mercado Pago

El `notification_url` no se configura a mano: lo manda el backend en cada
preferencia, construido desde `NEXTAUTH_URL`.

## Límites actuales

Ninguno es un bug. Son las condiciones bajo las que está corriendo hoy.

**El número de WhatsApp es de prueba** (`+1 555-145-1712`). Sólo puede
escribirle a una lista blanca de hasta 5 destinatarios, que se administra en
WhatsApp → Inicio rápido → Prueba la API → desplegable "Para". Cada número
agregado recibe un código que tiene que confirmar.

Para que le escriba cualquiera hacen falta **dos** cosas, no una: dar de alta un
número propio en la cuenta de WhatsApp Business, y completar la verificación del
negocio en Meta. El número de prueba nunca sale de la lista blanca, por más
verificado que esté el negocio.

**Gemini está en el tier gratuito**: 15 requests por minuto. Una reserva completa
consume entre 6 y 8, así que el techo real son unas dos conversaciones por
minuto. Pasado eso el bot manda el mensaje de disculpa. El agente respeta el
`retryDelay` que devuelve Google, lo que amortigua picos cortos pero no cambia
el límite.

**Mercado Pago está con credenciales de prueba.** Ojo: ya no se distinguen por
el prefijo — las de prueba también empiezan con `APP_USR-`. Para saber cuáles
están cargadas hay que mirar el panel de Mercado Pago, no la variable.

**La ventana de 24 horas de WhatsApp** aplica a los mensajes que inicia el bot.
El aviso de pago acreditado sólo llega si el huésped escribió en las últimas 24
horas. Fuera de esa ventana hace falta una plantilla aprobada por Meta.

## Diagnóstico

Casi todo se responde con dos consultas. La tabla `AgentRun` guarda la traza
completa de cada mensaje: entrada, salida, cada herramienta con sus argumentos
y su resultado, tokens y duración.

> Al consultar Neon a mano hay que calificar el esquema: `public."AgentRun"`,
> con las comillas. Neon deja el `search_path` vacío y sin calificar da
> `relation "AgentRun" does not exist` aunque la tabla exista.

**¿Está llegando el webhook de WhatsApp?**

```sql
SELECT provider, "externalId", "receivedAt"
FROM public."ProcessedEvent" ORDER BY "receivedAt" DESC LIMIT 10;
```

Si no hay filas `WHATSAPP` recientes, Meta no está llamando al endpoint. El
problema está en el panel de Meta, no en el código. El registro de webhooks que
muestra Meta es lo que *recibió de WhatsApp*, no lo que *reenvió* — que aparezcan
mensajes ahí no prueba nada.

**¿El agente corrió y qué contestó?**

```sql
SELECT status, "inboundText", "outboundText", error, iterations, "durationMs", "createdAt"
FROM public."AgentRun" ORDER BY "createdAt" DESC LIMIT 10;
```

Un `status` distinto de `OK` trae el error en la columna `error`.

**¿Se envió la respuesta?** Si hay una fila `OUTBOUND` en `Message` para ese
teléfono, sí: el turno se persiste **después** de que la Graph API acepta el
envío. Es la forma más directa de separar "el agente falló" de "el envío falló".

**¿Salió el email de confirmación?**

```sql
SELECT a.action, a.after, a."createdAt", r.code
FROM public."AuditLog" a JOIN public."Reservation" r ON r.id = a."reservationId"
WHERE a.action LIKE 'EMAIL_%' ORDER BY a."createdAt" DESC LIMIT 10;
```

Tres resultados posibles: `EMAIL_ENVIADO` con el id de Resend, `EMAIL_FALLIDO`
con el motivo, o `EMAIL_OMITIDO` si el huésped no dejó correo. Si no aparece
ninguna fila para una reserva confirmada, el deploy que la procesó es anterior
a esta trazabilidad.

**Ojo: `Payment.notifiedAt` NO dice nada del email.** Se setea después del envío
por WhatsApp, y el email sale antes y sin interrumpir nada si falla.

**¿Llegó el webhook de Mercado Pago?**

```sql
SELECT p.status, p."mpPaymentId", p."notifiedAt", r.code, r.status
FROM public."Payment" p JOIN public."Reservation" r ON r.id = p."reservationId"
ORDER BY p."createdAt" DESC LIMIT 10;
```

Un pago con `mpPaymentId` en null y la reserva en `PENDING_PAYMENT` significa
que el webhook nunca llegó. Verificar el `notification_url` que quedó grabado en
la preferencia, consultándolo contra la API de Mercado Pago:

```
GET https://api.mercadopago.com/checkout/preferences/{preferenceId}
Authorization: Bearer $MP_ACCESS_TOKEN
```

**¿Qué herramienta falla más?**

```sql
SELECT step->>'name' AS herramienta, count(*)
FROM public."AgentRun", jsonb_array_elements(steps) AS step
WHERE step->>'kind' = 'tool' AND (step->>'ok')::boolean = false
GROUP BY 1 ORDER BY 2 DESC;
```

**El cron**, a mano:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://roomly-n8n3.vercel.app/api/cron/expire-payments
```

## Lo que costó encontrar

Cuatro fallas que aparecieron recién al desplegar. Todas silenciosas: ninguna
producía un error visible.

**Doble barra en el `notification_url`.** `NEXTAUTH_URL` cargada con `/` al
final generaba `https://dominio//api/v1/payments/webhook`, que devuelve 308.
Mercado Pago no sigue redirects en las notificaciones: cuenta la entrega como
fallida y abandona. El huésped pagaba, MP cobraba, y la reserva se quedaba en
`PENDING_PAYMENT` hasta que el cron la cancelaba. Ya está corregido en el
código, que ahora normaliza la barra final.

**El agente llamaba a `crear_reserva` dos veces.** A veces se adelantaba y creaba
la reserva antes de que el huésped eligiera forma de pago; al recibir la
respuesta volvía a llamarla. La segunda chocaba con la primera y dejaba una
reserva huérfana bloqueando la habitación. No se arregla con prompt: es no
determinismo del modelo y aparece de forma intermitente. La herramienta es
idempotente ahora.

**El backoff ante 429 era inútil.** Gemini devuelve un `retryDelay` de 30-40
segundos; reintentar a los 600 ms quemaba los dos intentos disponibles.

**El modelo emitía Markdown**, que WhatsApp muestra literal. El prompt tiene
ahora reglas de formato explícitas.

## Deuda conocida

- **El webhook de Mercado Pago no valida firma.** El daño está acotado porque el
  pago se verifica contra la API de MP antes de confirmar nada, pero conviene
  validar el header `x-signature`.
- **Autenticación de un solo admin** en variables de entorno, sin rotación ni
  recuperación de contraseña.
- **`middleware.ts` quedó deprecado** en Next 16 a favor de `proxy`. El build lo
  avisa en cada corrida. El codemod oficial no lo migra porque el archivo usa
  `export default auth(...)` de next-auth.
- **El email depende de un dominio verificado en Resend** para llegarle a
  alguien que no sea el dueño de la cuenta.
- **Las variables de Vercel están en Production y Preview a la vez.** Un deploy
  de preview usaría la misma base y las mismas credenciales que producción.
