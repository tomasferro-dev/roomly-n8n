# Stack anterior (n8n + Docker + ngrok)

Nada de acá está en uso. Se archivó, en vez de borrarse, para que el stack
viejo siga siendo reconstruible mientras la versión en Vercel no lleve un
tiempo razonable estable en producción.

## Qué había antes

El bot de WhatsApp corría como un workflow de n8n (`workflow.json`, "Roomly
v14", 17 nodos) dentro de un contenedor Docker, expuesto a internet con ngrok.
El backend Next.js corría aparte y n8n lo llamaba por HTTP con un secreto
compartido en la query string.

```
WhatsApp → ngrok → n8n (Docker) → Gemini
                     └── 5 herramientas HTTP → backend Next.js → PostgreSQL
```

Hoy todo eso vive dentro del backend. El agente, las cinco herramientas, la
memoria conversacional y el canal de WhatsApp son código en `backend/lib/` y
`backend/app/api/whatsapp/`.

## Los archivos

| Archivo | Qué era |
|---|---|
| `workflow.json` | El workflow de n8n. Portado a `backend/lib/agent/` |
| `docker-compose.yml` | n8n + PostgreSQL + Redis para desarrollo local |
| `Dockerfile.n8n` | Imagen de n8n (era el `Dockerfile` de la raíz) |
| `Dockerfile.backend` | Build multi-stage del backend, para deploy en contenedor |
| `entrypoint.sh` | Corría `prisma migrate deploy` al arrancar el contenedor |
| `render.yaml` | Infraestructura como código para Render |
| `fly.toml` | Config de Fly.io |
| `WORKFLOW_NODOS.md` | Documentación nodo por nodo del workflow |
| `render-deploy.md` | Guía de deploy en Render |
| `SSE_TIEMPO_REAL.md` | El sistema de eventos en tiempo real vía Redis pub/sub |

## Dónde está cada cosa ahora

| Antes | Ahora |
|---|---|
| Nodo AI Agent + Gemini | `backend/lib/agent/run.ts` |
| Los 5 nodos `toolHttpRequest` | `backend/lib/agent/tools.ts` |
| System message del agente | `backend/lib/agent/prompt.ts` (y editable en `BotConfig`) |
| Nodo `memoryBufferWindow` | `backend/lib/agent/memory.ts` (tabla `Message`) |
| Nodos webhook de Meta | `backend/app/api/whatsapp/webhook/route.ts` |
| Nodos `whatsApp` | `backend/lib/channels/whatsapp.ts` |
| Historial de ejecuciones de n8n | Tabla `AgentRun` |
| Worker de BullMQ | Inline + `backend/app/api/cron/expire-payments/` |
| SSE sobre Redis pub/sub | Sondeo de `/api/dashboard/pulse` |
| PostgreSQL en Docker | Neon |
| ngrok | El dominio de Vercel |

## Si hiciera falta volver atrás

El camino de vuelta más corto no es resucitar esto: es reapuntar el webhook en
el panel de Meta Developers a una instancia de n8n. Para eso hace falta n8n
corriendo, importar `workflow.json` y cargarle a mano las credenciales de
Gemini y de WhatsApp.

Para levantarlo localmente:

```bash
docker compose -f docs/legacy/docker-compose.yml --env-file .env up -d
```

Tené en cuenta que el `docker-compose.yml` publica PostgreSQL en el puerto
5433, que puede estar tomado por otro proyecto.

## Cuándo borrar esta carpeta

Cuando la versión en Vercel lleve unas semanas estable en producción. Todo
sigue estando en la historia de git igual.
