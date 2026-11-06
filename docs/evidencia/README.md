# Evidencia del trabajo final

Archivos en los que se apoyan las Tablas 12, 14 y 15 y los Anexos E, F e I de la tesis.
`SHA256SUMS` tiene el hash de cada archivo, también consignado en el Anexo A; se
verifica con:

```bash
sha256sum -c SHA256SUMS
```

Los archivos se guardan sin conversión de fin de línea (`.gitattributes`), para que
el hash coincida en cualquier sistema.

| Archivo | Contenido | Usado en |
|---|---|---|
| `agent-check_*.txt` | Salida de `npm run agent:check` en cada fecha y commit | Anexo E, Tabla 10 |
| `metricas-agentrun_*.json` | Consultas de solo lectura sobre la tabla `AgentRun` | Tabla 14, Anexo F |
| `garantias-y-metricas_2026-10-26.json` | Estado de la base: superposiciones, duplicados, pagos | Tablas 12 y 15 |
| `prueba-garantias_2026-10-26.json` | Concurrencia y repetición sobre una branch de Neon | §4.6, Tabla 15 |
| `prueba-titularidad_2026-10-27.json` | Control de titularidad con dos teléfonos de prueba | §5.9 |
| `firma-meta_2026-10-27.txt` | Rechazo de firmas falsas en el webhook de producción | §5.9 |
| `prueba-whatsapp_2026-11-05.json` | Prueba por WhatsApp de extremo a extremo: capacidad, fecha pasada, reserva con pago, reserva repetida y cancelación | §5.9 |
| `conversaciones-prueba_seudonimizadas.txt` | Conversaciones de prueba exportadas de WhatsApp | §5.6, Anexo I |
| `clasificacion-mensajes_2026-10-27.csv` | Clasificación de los 62 mensajes del huésped | §5.6, Anexo I |

Los teléfonos que aparecen son ficticios (`5493510000000`, `54900…`) y las
conversaciones están seudonimizadas: nombres, correos e identificadores de pago
reemplazados.

## Reproducir las pruebas automatizadas

Con Node.js 24 (probado con 24.21.0):

```bash
cd backend
export DATABASE_URL="postgresql://u:p@localhost:5432/x"   # cualquiera: las pruebas no usan la base
npm ci
npm run agent:check
```

`DATABASE_URL` hace falta porque `npm ci` ejecuta `prisma generate`, y la
configuración de Prisma la exige aunque las pruebas no se conecten.
