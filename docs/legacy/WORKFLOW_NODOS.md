# Roomly – Documentación de nodos del workflow

Versión actual: **v14**  
Archivo fuente: `workflow.json`

> **⚠️ Importante:** Este archivo debe actualizarse siempre que se agregue, modifique o elimine un nodo en `workflow.json`.

> **ℹ️ Nombres de nodos con sufijo `1` en la instancia viva.** Al re-importar el
> `workflow.json` sobre un workflow ya existente, n8n renombra los nodos agregando
> un `1` (`Extraer datos del mensaje1`, `AI Agent – Roomly1`, etc.) para evitar
> colisiones, y reescribe solo las expresiones que los referencian. Por eso, en el
> n8n actual los `$('...')` apuntan a los nombres **con** `1`. Si editás una
> expresión a mano en la UI, respetá ese nombre. En `workflow.json` (repo) los
> nombres van **sin** el sufijo.

---

## Diagrama de flujo

```
META (verificación)
  GET /webhook/roomly-wa
       │
       ▼
  Responder challenge ──────────────────────────────────────── FIN


META (mensajes reales)
  POST /webhook/roomly-wa
       │
       ▼
  Ack 200  ──►  Extraer datos del mensaje  ──►  AI Agent – Roomly
                                                      │
                                          ┌───────────┴───────────┐
                                    sub-nodos del agente:
                                    · Gemini Flash (LLM)
                                    · Memoria por usuario
                                    · consultar_habitaciones (tool)
                                    · crear_reserva (tool)
                                    · consultar_reserva (tool)
                                    · modificar_reserva (tool)
                                    · cancelar_reserva (tool)
                                          │
                                          ▼
                                   ¿Hay respuesta?
                                   /              \
                              TRUE               FALSE
                                │                  │
                                ▼                  ▼
                     Enviar respuesta       Enviar error
                       al usuario           al usuario
                                │
                                ▼
                     Logging de interacción ──── FIN
```

---

## Nodos – detalle completo

### 1. Verificación Meta (GET)
| Campo | Valor |
|-------|-------|
| **Tipo** | `n8n-nodes-base.webhook` |
| **ID** | `n-webhook-get` |
| **Método HTTP** | GET |
| **Path** | `roomly-wa` |
| **Modo de respuesta** | `responseNode` |

**Función:**  
Punto de entrada para la verificación del webhook de Meta/WhatsApp. Cuando se configura o reconfigura el webhook en Meta Developer Console, Meta envía un GET con los query params `hub.mode`, `hub.verify_token` y `hub.challenge`. Este nodo captura ese GET y lo pasa al siguiente nodo para responder correctamente.

**¿Por qué existe separado del POST?**  
n8n no enruta requests GET a nodos con `httpMethod: "ALL"`. Necesita un nodo dedicado por método.

---

### 2. Responder challenge
| Campo | Valor |
|-------|-------|
| **Tipo** | `n8n-nodes-base.respondToWebhook` |
| **ID** | `n-respond-get` |
| **Responde con** | texto plano |

**Función:**  
Extrae el valor de `hub.challenge` del query string y lo devuelve tal cual como texto plano. Meta espera recibir exactamente ese valor para confirmar que el webhook es legítimo.

**Expresión usada:**
```
={{ ($json.query?.hub?.challenge) ?? ($json.query?.['hub.challenge']) ?? '' }}
```
Maneja dos formatos posibles que n8n puede parsear el query string (`hub.challenge` como objeto anidado o como clave con punto).

---

### 3. WhatsApp Mensajes (POST)
| Campo | Valor |
|-------|-------|
| **Tipo** | `n8n-nodes-base.webhook` |
| **ID** | `n-webhook-post` |
| **Método HTTP** | POST |
| **Path** | `roomly-wa` |
| **Modo de respuesta** | `responseNode` |

**Función:**  
Punto de entrada para los mensajes reales de WhatsApp. Meta envía un POST cada vez que un usuario le escribe al número. El modo `responseNode` permite enviar el `200 OK` a Meta inmediatamente (sin esperar a que termine todo el flujo) y seguir procesando en background.

---

### 4. Ack 200
| Campo | Valor |
|-------|-------|
| **Tipo** | `n8n-nodes-base.respondToWebhook` |
| **ID** | `n-respond-post` |
| **Responde con** | `"OK"` (texto plano, HTTP 200) |

**Función:**  
Responde a Meta con `200 OK` de forma inmediata. Esto es obligatorio: si Meta no recibe un 200 en pocos segundos, marca el webhook como fallido y reintenta el envío. Después de que este nodo ejecuta, el flujo continúa en background sin bloquear la respuesta HTTP.

---

### 5. Extraer datos del mensaje
| Campo | Valor |
|-------|-------|
| **Tipo** | `n8n-nodes-base.code` (JavaScript) |
| **ID** | `n-extract-001` |

**Función:**  
Parsea el payload JSON crudo de Meta y extrae los campos necesarios para el flujo. El webhook genérico de n8n no desenvuelve el payload como lo hacía el nodo `whatsAppTrigger`, por eso es necesario este paso.

**Campos que extrae:**
| Campo | Descripción |
|-------|-------------|
| `phoneNumberId` | ID del número de WhatsApp Business (necesario para enviar respuestas) |
| `from` | Número de teléfono del usuario que escribió (sin `+`) |
| `messageText` | Texto del mensaje |
| `timestamp` | Timestamp Unix del mensaje |

**Filtros:** Si el mensaje no es de tipo `text`, o el texto está vacío, devuelve `[]` y el flujo se detiene (descarta notificaciones de estado, lecturas, multimedia, etc.).

---

### 6. AI Agent – Roomly
| Campo | Valor |
|-------|-------|
| **Tipo** | `@n8n/n8n-nodes-langchain.agent` |
| **ID** | `c020e75b-8f4c-4a83-abfc-646a4db0baac` |
| **typeVersion** | 1.8 |
| **retryOnFail** | true |

**Función:**  
Cerebro del bot. Recibe el texto del usuario (`$json.messageText`) y, guiado por el system prompt, decide qué tools llamar y qué responderle al huésped. Maneja cuatro acciones: nueva reserva, consulta, modificación y cancelación.

**System prompt (resumen):**
- Identidad: "Roomly, recepcionista virtual de hotel"
- Sabe la fecha actual (`$now.toISO()`) y el teléfono del huésped
- Flujo obligatorio para reservas: primero `consultar_habitaciones`, luego `crear_reserva`
- `guestPhone` siempre viene del sistema (no del usuario)
- Al listar habitaciones disponibles, **siempre muestra el precio por noche** de cada una (ej: "Hab. 101 – Standard – $25.000/noche")
- Al confirmar una reserva, **incluye el total estimado** (precio/noche × noches) en el mensaje de confirmación
- Precios con formato argentino (`$25.000`, no `$25000`); fechas al usuario en `DD/MM/YYYY`
- Respuestas cortas, español rioplatense
- Si el mensaje no es sobre reservas, redirige

**Sub-nodos conectados:** Gemini Flash (LLM), Memoria por usuario, y los 5 tools HTTP.

---

### 7. ¿Hay respuesta?
| Campo | Valor |
|-------|-------|
| **Tipo** | `n8n-nodes-base.if` |
| **ID** | `n-if-output` |

**Función:**  
Guard que verifica que el agente devolvió algo en `$json.output` antes de intentar enviar el mensaje. Si el agente falla (Gemini 429, timeout, error interno), `output` queda vacío o indefinido y este nodo desvía al flujo de error.

| Rama | Condición | Destino |
|------|-----------|---------|
| TRUE | `$json.output` no está vacío | → Enviar respuesta al usuario |
| FALSE | `$json.output` vacío/undefined | → Enviar error al usuario |

---

### 8. Enviar respuesta al usuario
| Campo | Valor |
|-------|-------|
| **Tipo** | `n8n-nodes-base.whatsApp` |
| **ID** | `834511e9-120a-4af5-8c78-5deb94123e0e` |
| **Operación** | `send` |

**Función:**  
Envía la respuesta del AI Agent al usuario por WhatsApp.

| Parámetro | Valor |
|-----------|-------|
| `phoneNumberId` | `$('Extraer datos del mensaje').item.json.phoneNumberId` |
| `recipientPhoneNumber` | `$('Extraer datos del mensaje').item.json.from.replace(/^549/, '54')` |
| `textBody` | `$json.output` (respuesta del agente) |

> **⚠️ Quirk de Argentina (`549` → `54`).** WhatsApp **entrega** los mensajes
> entrantes con el `9` de móvil (`549…`), pero la Cloud API espera el número
> **canónico sin el `9`** (`54…`) para **enviar**. Mandar al `549…` devuelve
> `Bad request – Recipient phone number not in allowed list` (HTTP 400). Por eso
> el destinatario se normaliza con `.replace(/^549/, '54')`. Solo afecta el envío;
> el número que se usa para huésped/memoria/log sigue con el `9` (consistente con
> los datos existentes). Ver `PROBLEMAS_Y_SOLUCIONES.md` [008].

---

### 9. Enviar error al usuario
| Campo | Valor |
|-------|-------|
| **Tipo** | `n8n-nodes-base.whatsApp` |
| **ID** | `n-error-msg` |
| **Operación** | `send` |

**Función:**  
Fallback que se ejecuta cuando el agente no pudo generar respuesta (rama FALSE de "¿Hay respuesta?"). Envía un mensaje de disculpa al usuario para que no quede sin respuesta.

**Mensaje fijo:**
> "Disculpá, tuve un problema técnico y no pude procesar tu mensaje. Por favor intentá de nuevo en unos segundos. 🙏"

| Parámetro | Valor |
|-----------|-------|
| `phoneNumberId` | `$('Extraer datos del mensaje').item.json.phoneNumberId` |
| `recipientPhoneNumber` | `$('Extraer datos del mensaje').item.json.from.replace(/^549/, '54')` (mismo quirk del `9`, ver nodo 8) |

---

### 10. Logging de interacción
| Campo | Valor |
|-------|-------|
| **Tipo** | `n8n-nodes-base.httpRequest` |
| **ID** | `cf6fe2da-d663-4d2d-8818-7ac6d1ecf6cb` |
| **Método** | POST |

**Función:**  
Guarda cada turno de la conversación (mensaje del usuario + respuesta del bot) en
el backend, para reconstruir el chat y usarlo después en mejoras del sistema.
Antes era un placeholder (`return []`); ahora hace un POST al endpoint de logging.

**Endpoint:** `POST {{ $env.BACKEND_URL }}/api/v1/conversations/log?_s={{ $env.N8N_WEBHOOK_SECRET }}`

**Body (JSON, vía expresión):**
```js
={{ JSON.stringify({
  phone:       $('Extraer datos del mensaje').item.json.from,
  userMessage: $('Extraer datos del mensaje').item.json.messageText,
  botMessage:  $('AI Agent – Roomly').item.json.output,
  waTimestamp: $('Extraer datos del mensaje').item.json.timestamp,
  hotelId:     $env.HOTEL_ID,
  channel:     'WHATSAPP'
}) }}
```

**Notas:**
- Se usa un nodo **HTTP Request** (no Code) para evitar el bloqueo de `$env` en los
  Code nodes y mantener el patrón de los demás llamados al backend.
- Va **después** de "Enviar respuesta al usuario", así que solo loguea el camino de
  **éxito** (no el de error). El backend crea 1–2 filas `Message` (INBOUND/OUTBOUND).
- El backend deriva el "chat por reserva" a partir de estos mensajes (ver
  `BACKEND.md` → Captura de chat).

---

### 11. Memoria por usuario
| Campo | Valor |
|-------|-------|
| **Tipo** | `@n8n/n8n-nodes-langchain.memoryBufferWindow` |
| **ID** | `0a5183d6-9805-42a3-82e5-bced79defb47` |
| **typeVersion** | 1.3 |

**Función:**  
Provee memoria conversacional al AI Agent. Mantiene las últimas N interacciones por usuario para que el agente recuerde el contexto de la conversación.

| Parámetro | Valor |
|-----------|-------|
| `sessionKey` | `$('Extraer datos del mensaje').item.json.from` (teléfono del usuario) |
| `contextWindowLength` | 10 mensajes |

La clave de sesión es el número de teléfono, así cada usuario tiene su propio historial independiente.

---

### 12. Gemini Flash
| Campo | Valor |
|-------|-------|
| **Tipo** | `@n8n/n8n-nodes-langchain.lmChatGoogleGemini` |
| **ID** | `7b147711-a013-42bb-8558-a3b7ce6b03f3` |
| **Modelo** | `models/gemini-3.1-flash-lite` |

**Función:**  
LLM que alimenta al AI Agent. Es el modelo de lenguaje que procesa el system prompt + historial + mensaje del usuario y decide las acciones a tomar.

| Parámetro | Valor | Motivo |
|-----------|-------|--------|
| `maxOutputTokens` | 512 | Respuestas cortas de WhatsApp, ahorra cuota |
| `temperature` | 0.1 | Baja aleatoriedad → respuestas consistentes y predecibles |

> **⚠️ Modelos problemáticos:**  
> - `gemini-2.5-flash` → 429 Too Many Requests (rate limit muy bajo en free tier)  
> - `gemini-1.5-flash` → 404 (no existe en la API)  
> - ✅ Usar siempre `models/gemini-3.1-flash-lite`

**Credencial requerida:** `Google Gemini(PaLM) Api account`

---

### 13. consultar_habitaciones *(tool)*
| Campo | Valor |
|-------|-------|
| **Tipo** | `@n8n/n8n-nodes-langchain.toolHttpRequest` |
| **ID** | `b1a00001-0001-0001-0001-000000000001` |
| **Método** | GET |

**Función:**  
Tool que el AI Agent llama para consultar disponibilidad de habitaciones. Devuelve la lista de habitaciones disponibles para el rango de fechas dado.

**Endpoint:** `GET /api/v1/rooms?hotelId=...&_s=...&checkIn={checkIn}&checkOut={checkOut}`

**Parámetros del agente:**
| Param | Tipo | Descripción |
|-------|------|-------------|
| `checkIn` | string | Fecha de entrada (YYYY-MM-DD) |
| `checkOut` | string | Fecha de salida (YYYY-MM-DD) |

**Respuesta esperada:** Array de habitaciones con `id`, número, tipo, capacidad, **`pricePerNight`** (número, puede ser `null` si no hay tarifa) y **`ratePlanName`**.

> El agente **SIEMPRE** debe llamar esto antes de `crear_reserva` para obtener el `roomId` y el precio por noche.

---

### 14. crear_reserva *(tool)*
| Campo | Valor |
|-------|-------|
| **Tipo** | `@n8n/n8n-nodes-langchain.toolHttpRequest` |
| **ID** | `b1a00001-0002-0002-0002-000000000002` |
| **Método** | GET |

**Función:**  
Tool para crear una nueva reserva. Devuelve la reserva creada con su código RML.

**Endpoint:** `GET /api/v1/reservations/crear?hotelId=...&channel=WHATSAPP&_s=...&roomId=...&...`

**Parámetros del agente:**
| Param | Tipo | Descripción |
|-------|------|-------------|
| `roomId` | string | ID de la habitación (viene de `consultar_habitaciones`) |
| `guestName` | string | Nombre completo del huésped |
| `guestPhone` | string | Teléfono del huésped sin `+` (viene del sistema, no del usuario) |
| `checkIn` | string | Fecha entrada (YYYY-MM-DD) |
| `checkOut` | string | Fecha salida (YYYY-MM-DD) |
| `numGuests` | number | Cantidad de personas |

**Respuesta esperada:** Objeto reserva con `code` (ej: `RML-1234`), `status: "CONFIRMED"`, etc.

---

### 15. consultar_reserva *(tool)*
| Campo | Valor |
|-------|-------|
| **Tipo** | `@n8n/n8n-nodes-langchain.toolHttpRequest` |
| **ID** | `b1a00001-0003-0003-0003-000000000003` |
| **Método** | GET |

**Función:**  
Tool para buscar una reserva existente por código RML. Devuelve los detalles completos, incluyendo el campo `id` interno necesario para modificar o cancelar.

**Endpoint:** `GET /api/v1/reservations?_s=...&code={code}`

**Parámetros del agente:**
| Param | Tipo | Descripción |
|-------|------|-------------|
| `code` | string | Código RML (ej: `RML-1234`) |

---

### 16. modificar_reserva *(tool)*
| Campo | Valor |
|-------|-------|
| **Tipo** | `@n8n/n8n-nodes-langchain.toolHttpRequest` |
| **ID** | `b1a00001-0004-0004-0004-000000000004` |
| **Método** | GET |

**Función:**  
Tool para modificar fechas o cantidad de personas de una reserva existente. Requiere primero llamar `consultar_reserva` para obtener el `id` interno.

**Endpoint:** `GET /api/v1/reservations/modificar?_s=...&id={id}&checkIn={checkIn}&checkOut={checkOut}&numGuests={numGuests}`

**Parámetros del agente:**
| Param | Tipo | Descripción |
|-------|------|-------------|
| `id` | string | ID interno de la reserva (de `consultar_reserva`) |
| `checkIn` | string | Nueva fecha entrada (omitir si no cambia) |
| `checkOut` | string | Nueva fecha salida (omitir si no cambia) |
| `numGuests` | number | Nueva cantidad de personas (omitir si no cambia) |

---

### 17. cancelar_reserva *(tool)*
| Campo | Valor |
|-------|-------|
| **Tipo** | `@n8n/n8n-nodes-langchain.toolHttpRequest` |
| **ID** | `b1a00001-0005-0005-0005-000000000005` |
| **Método** | GET |

**Función:**  
Tool para cancelar una reserva (cambia su estado a `CANCELLED`). Requiere primero llamar `consultar_reserva` para obtener el `id` interno, y **solo debe ejecutarse tras confirmación explícita del huésped**.

**Endpoint:** `GET /api/v1/reservations/cancelar?_s=...&id={id}`

**Parámetros del agente:**
| Param | Tipo | Descripción |
|-------|------|-------------|
| `id` | string | ID interno de la reserva a cancelar |

---

## Credenciales necesarias

| Credencial | Usado en | Cómo configurar |
|------------|----------|-----------------|
| `WhatsApp account` | Enviar respuesta al usuario, Enviar error al usuario | App de Meta, token de acceso (ver ⚠️ abajo) |
| `Google Gemini(PaLM) Api account` | Gemini Flash | API Key de Google AI Studio |

> **⚠️ Token de WhatsApp – temporal vs permanente.** Actualmente se usa el **token
> temporal de "API Setup"** de Meta, que **expira a las 24 h**. Cuando expira, el
> bot deja de responder y las ejecuciones fallan con
> `Authorization failed - please check your credentials` en el nodo de envío
> (ver `PROBLEMAS_Y_SOLUCIONES.md` [007]). Para no tener que renovarlo a diario,
> generar un **token permanente de System User** (Meta Business Settings → Users →
> System Users → generar token con permisos `whatsapp_business_messaging` +
> `whatsapp_business_management`) y reemplazarlo en la credencial.

> **ℹ️ Lista de destinatarios permitidos (modo de prueba).** Si la app está en modo
> desarrollo, Meta solo permite enviar a números **verificados** en la lista *"To"*
> de API Setup. Para Argentina hay que tener en cuenta el quirk del `9` (el envío
> normaliza a `54…`, ver nodo 8). Ver `PROBLEMAS_Y_SOLUCIONES.md` [008].

---

## Variables de entorno usadas por el workflow

Todas se definen en `C:\Users\David\roomly-n8n\.env` y se pasan al contenedor de n8n vía `--env-file`.

| Variable | Descripción |
|----------|-------------|
| `BACKEND_URL` | URL base del backend Next.js (ej: `http://host.docker.internal:3000`) |
| `HOTEL_ID` | ID del hotel en la base de datos |
| `N8N_WEBHOOK_SECRET` | Secret para autenticar requests de n8n al backend (parámetro `_s`) |
| `WHATSAPP_RECIPIENT` | ~~Número de teléfono destino~~ — ya no se usa. El workflow usa el número dinámico del remitente (`from`). |
