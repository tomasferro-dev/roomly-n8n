# Deploy a Render

## Costo estimado

| Servicio | Plan | Costo |
|----------|------|-------|
| PostgreSQL | Starter | $7/mes |
| Redis | Free | $0 |
| Backend (Next.js) | Free | $0 |
| n8n | Free | $0 |
| **Total** | | **$7/mes** |

> ⚠️ El plan Free hace spin-down tras 15 min de inactividad (~30s de cold start).
> Para producción con tráfico real, subir backend y n8n a Starter ($7/mes cada uno → $21/mes total).

---

## Pasos

### 1. Crear cuenta en Render
[render.com](https://render.com) → Sign up con GitHub

### 2. Conectar el repositorio
Render → Dashboard → New → Blueprint → conectar el repo `roomly-n8n`

Render detecta automáticamente el `render.yaml` y crea todos los servicios.

### 3. Completar las variables de entorno marcadas como `sync: false`

Una vez que los servicios estén creados (antes del primer deploy), completar en el dashboard de Render:

#### roomly-backend
| Variable | Valor |
|----------|-------|
| `NEXTAUTH_URL` | `https://roomly-backend.onrender.com` |
| `ADMIN_EMAIL` | `admin@hotel.com` |
| `ADMIN_PASSWORD_HASH` | Hash bcrypt de tu contraseña (ver abajo) |
| `N8N_WEBHOOK_SECRET` | Cualquier string random (ej: `roomly-prod-secret-xxxx`) |
| `N8N_BASE_URL` | `https://roomly-n8n.onrender.com` |
| `MP_ACCESS_TOKEN` | Token de MP (sandbox o producción) |
| `WHATSAPP_PHONE_NUMBER_ID` | ID del número de WhatsApp Business |
| `WHATSAPP_ACCESS_TOKEN` | Token permanente de System User de Meta |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | (igual que local, opcional) |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | (igual que local, opcional) |
| `GOOGLE_CALENDAR_ID` | (igual que local, opcional) |

#### roomly-n8n
| Variable | Valor |
|----------|-------|
| `N8N_HOST` | `roomly-n8n.onrender.com` (sin `https://`) |
| `WEBHOOK_URL` | `https://roomly-n8n.onrender.com/` |
| `N8N_EDITOR_BASE_URL` | `https://roomly-n8n.onrender.com/` |
| `BACKEND_URL` | `https://roomly-backend.onrender.com` |
| `N8N_WEBHOOK_SECRET` | Mismo valor que en el backend |
| `HOTEL_ID` | Completar después del primer deploy (ver paso 5) |

#### Generar ADMIN_PASSWORD_HASH
```powershell
node -e "const b=require('bcryptjs'); console.log(b.hashSync('TU_PASSWORD', 10))"
```
Escapar los `$` con `\$` al pegarlo en Render.

### 4. Primer deploy
Render despliega automáticamente. El backend corre `prisma migrate deploy` al arrancar.

Verificar que el backend responde:
```
https://roomly-backend.onrender.com/dashboard
```

### 5. Obtener el HOTEL_ID
Abrir el dashboard → Configuración. El hotel se crea con el seed inicial.

O via API:
```
GET https://roomly-backend.onrender.com/api/v1/hotels?_s=TU_N8N_WEBHOOK_SECRET
```

Copiar el `id` del hotel y completarlo como `HOTEL_ID` en el servicio `roomly-n8n`.

### 6. Configurar n8n
1. Abrir `https://roomly-n8n.onrender.com`
2. Crear cuenta de administrador
3. Configurar credenciales:
   - **WhatsApp account**: token permanente de Meta System User
   - **Google Gemini API**: API key de Google AI Studio
4. Importar `workflow.json`: Workflows → ··· → Import from file
5. Activar el workflow (toggle en esquina superior derecha)

### 7. Configurar Meta (WhatsApp)
En [developers.facebook.com](https://developers.facebook.com) → tu app → WhatsApp → Configuration:
- **Webhook URL**: `https://roomly-n8n.onrender.com/webhook/roomly-wa`
- **Verify token**: cualquier string (configurar en n8n también)

### 8. Configurar Mercado Pago (producción)
En el panel de MP → tu app → Webhooks:
- **URL**: `https://roomly-backend.onrender.com/api/v1/payments/webhook`
- **Eventos**: `payment`

---

## Diferencias respecto al entorno local

| Local | Render |
|-------|--------|
| ngrok para exponer puertos | URLs públicas automáticas |
| `localhost:3000` | `https://roomly-backend.onrender.com` |
| `localhost:5678` | `https://roomly-n8n.onrender.com` |
| `host.docker.internal:3000` | `https://roomly-backend.onrender.com` |
| Webhook MP simulado a mano | MP envía webhook automáticamente |
| PostgreSQL en Docker | Render Managed PostgreSQL |

---

## Actualizar el deploy

Cada `git push` a `master` triggerea un re-deploy automático en Render.

Para re-deploy manual: Render Dashboard → el servicio → Manual Deploy → Deploy latest commit.

---

## Rollback

Render Dashboard → el servicio → Events → cualquier deploy anterior → Rollback to this deploy.
