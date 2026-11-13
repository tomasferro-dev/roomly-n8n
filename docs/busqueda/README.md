# Protocolo de búsqueda bibliográfica

Búsqueda documentada del 12/11/2026 que respalda el Marco teórico (capítulo 2)
y el Anexo J. Complementa la búsqueda de antecedentes de octubre de 2026
descrita en la sección 2.10. Es una búsqueda acotada y reproducible, no una
revisión sistemática: se criban los 25 primeros resultados por relevancia de
cada cadena en cada base.

## Preguntas

- **Bloque A.** ¿Qué sistemas conversacionales para reservas o atención en
  turismo y hotelería se publicaron, con qué tecnología y cómo se evaluaron, y
  qué se sabe de su adopción?
- **Bloque B.** ¿Cómo se evalúan los agentes de lenguaje con herramientas y qué
  tan estables son sus resultados entre corridas?
- **Bloque C.** ¿Qué mecanismos aseguran la integridad de los datos ante
  concurrencia y reintentos en aplicaciones web y serverless?

## Bases, período y cadenas

- **OpenAlex** (trabajos arbitrados: artículos, ponencias y revisiones),
  búsqueda en título y resumen.
- **arXiv** (preprints), búsqueda en el resumen.
- **Período:** 01/01/2019 a 12/11/2026. **Idiomas:** inglés y español.

| Cadena | Bloque | Términos | OpenAlex | arXiv |
|---|---|---|---|---|
| A1 | A | (hotel OR hospitality) AND (chatbot OR "conversational agent") AND (booking OR reservation) | 111 | 8 |
| A2 | A | ("large language model" OR LLM) AND (hotel OR tourism OR travel) AND (agent OR assistant) | 272 | 178 |
| B1 | B | ("tool use" OR "function calling" OR "tool learning") AND ("language model" OR LLM) AND agent AND (benchmark OR evaluation) | 584 | 1144 |
| B2 | B | ("language model" OR LLM) AND (nondeterminism OR "non-determinism" OR reproducibility OR consistency) AND (temperature OR runs) | 816 | 557 |
| C1 | C | (idempotence OR idempotency OR "exactly-once") AND (serverless OR "web application" OR microservices) | 66 | 6 |
| C2 | C | ("concurrency control" OR "isolation anomalies" OR "write skew" OR "ad hoc transactions") AND ("web application" OR database) | 393 | 50 |

Las cadenas exactas enviadas a cada API están en `resultados-2026-11-12.json`
(en arXiv, cada grupo lleva el prefijo `abs:`).

## Criterios

**Cribado por título y resumen.** Se incluye un trabajo si responde a la
pregunta de su bloque. Se excluye por:

- **E1:** no responde a la pregunta del bloque (otro dominio, otro problema, o
  un sistema sin evaluación ni aporte transferible);
- **E2:** repositorio sin arbitraje y sin método verificable.

**Lectura completa.** Se incorpora al capítulo si aporta evidencia para una
decisión de diseño o de evaluación del trabajo. Se excluye por:

- **T1:** el problema que estudia no incluye reserva ni cobro;
- **T2:** su aporte ya lo cubre una fuente citada, o no cambia ninguna decisión
  del trabajo.

## Resultados

| Etapa | Cantidad |
|---|---|
| Resultados totales de las 12 búsquedas | 4185 |
| Cribados (25 primeros por relevancia de cada búsqueda) | 264 |
| Duplicados entre búsquedas | 16 |
| Únicos cribados por título y resumen | 248 |
| Excluidos en el cribado (E1: 219, E2: 6) | 225 |
| Leídos completos | 23 |
| Excluidos en la lectura completa (T1: 3, T2: 9) | 12 |
| **Incluidos** | **11** |
| · ya citados antes de esta búsqueda | 6 |
| · incorporados a partir de esta búsqueda | 5 |

Incorporados: Gassen et al. (2022), Nguyen y Phan (2026), Ouyang et al. (2025),
Windisch et al. (2026) y Yehudai et al. (2026). Las demás fuentes del capítulo
provienen de la búsqueda de antecedentes de octubre de 2026 (sección 2.10), de
las referencias de los trabajos leídos y de la documentación oficial de las
tecnologías usadas.

`cribado.csv` registra la decisión y el motivo de cada uno de los 248 trabajos.
