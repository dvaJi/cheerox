# Plan de rendimiento: estado y trabajo pendiente

## Objetivo

La meta acordada para la rama `perf/1.5x-everything` es lograr al menos **1,5× en todas las operaciones representativas**, sin regresiones, y comprobar que los resultados sean equivalentes a Cheerio. La meta sigue abierta. Una prueba de compatibilidad aprobada no compensa una operación lenta; una mejora aislada tampoco demuestra la meta global.

Este archivo resume qué se investigó, qué cambios se retuvieron, qué experimentos se descartaron y qué falta hacer. [PERFORMANCE-INVESTIGATION.md](./PERFORMANCE-INVESTIGATION.md) contiene el historial técnico, las comparaciones pareadas, intervalos y detalles por experimento.

## Estado actual medido

Corrida de `node --expose-gc bench/operations.mjs --mode html`, 21 muestras por operación en Node 24.18.0, Windows x64, fixture HTML sintético (494 KB a 2.000 tarjetas). Cada operación verifica igualdad de salida con Cheerio 1.2. La columna «total» incluye carga; «op.» mide solo la operación. Son medianas diagnósticas de una corrida; las decisiones de rendimiento usan comparaciones pareadas (ver investigación).

El resultado JSON completo está guardado en [2026-11-12-operations-html.json](./results/2026-11-12-operations-html.json).

| Operación | 200 tarjetas total | 2.000 tarjetas total | 2.000 tarjetas op. |
| --- | ---: | ---: | ---: |
| Carga | 1,62× | 1,76× | — |
| Selección por etiqueta | 2,26× | 1,97× | 8,92× |
| Selección compuesta | 2,27× | 1,96× | 5,76× |
| Texto de selección | 2,29× | 2,00× | 6,36× |
| HTML de selección | 2,35× | 1,99× | 7,82× |
| Serializar documento | 2,54× | 2,52× | 11,73× |
| `attr` por elemento | 1,28× | 1,56× | 1,11× |
| Propiedad `attribs` | 1,34× | 1,72× | 1,55× |
| `map` y `get` | 1,68× | 2,19× | 3,72× |
| `closest` por elemento | 1,61× | 1,99× | 2,43× |
| Contar padres | 1,10× | 1,44× | 0,88× |
| Padre y hermanos | 1,12× | 1,43× | 0,83× |
| Hijos y siguiente | 1,12× | 1,48× | 0,94× |
| `find` por elemento | 1,64× | 1,92× | 2,29× |
| `is` y `filter` | 1,53× | 1,84× | 2,05× |
| Recorrido de hijos en JS | 1,05× | 1,32× | 0,33× |
| Recorrido y lectura de campos | 0,69× | 0,74× | 0,16× |
| Contenidos y nodos de texto | 1,72× | 2,00× | 2,81× |
| Establecer atributos | 1,32× | 1,56× | 1,13× |
| Eliminar elementos | 1,60× | 1,78× | 1,89× |
| Añadir y anteponer | 1,85× | 2,37× | 3,35× |
| Reemplazar texto y HTML | 1,40× | 1,63× | 1,43× |
| Mutar y serializar | 1,62× | 1,82× | 1,95× |
| Reescribir atributos por elemento | 1,23× | 1,32× | 0,74× |
| Clonar e insertar | 1,28× | 1,60× | 1,28× |
| Mapa de extracción | 1,93× | 2,79× | 21,39× |

Dieciséis de veinticinco operaciones superan 1,5× total a 2.000 tarjetas (antes: ninguna); la carga pasó de paridad (0,99×) a 1,76×. El gate de rendimiento más reciente pasa en HTML y XML. Las tres cadenas de selección (contar padres, padre y hermanos, hijos y siguiente) quedan en 1,43–1,48×, y los recorridos JS siguen debajo: su costo por nodo es materialización de vistas, no lectura.

Comparaciones pareadas contra el build de la cabeza del PR (30 rondas alternadas, fixture de artículos de 220 KB del harness, corrida final): carga 1,828× (1,804–1,849), recorrido de hijos 1,629× (1,610–1,663), recorrido con campos 1,313× (1,281–1,355), atributos 1,638× (1,619–1,683), selección por etiqueta 1,723× (1,693–1,763), extracción corta 1,828× (1,813–1,855), documentos mixtos 10,006× (9,814–10,204). En XML a 60 rondas: recorrido con campos 1,071× (1,049–1,082) y atributos 1,019× (1,001–1,033) total, con la operación sola en paridad; el costo restante de operación es materialización de objetos de atributos, el precio de lecturas ~4× más baratas en caliente.

## Cambios retenidos con evidencia de mejora

- **Escaneo rápido de etiquetas completas en el tokenizer vendido.** El 97 % de la carga era el parseo html5ever; el markup de etiquetas pasaba carácter a carácter por la máquina de estados mientras el estado Data tenía un camino SIMD. Un escáner de bytes de etiqueta completa (con fallback estricto a la máquina) dejó el parseo de 494 KB en 23,8 → 14,0 ms y el tokenizer solo en 14,5 → 4,5 ms. Los errores de parseo descartados no son observables: el camino principal usa un sink sin colector y los diagnósticos/locations pasan por un parseo html5gum independiente. Detalle y diagnósticos de fase en [tokenización rápida](./PERFORMANCE-INVESTIGATION.md#load-phase-diagnosis-and-fast-whole-tag-tokenization).
- **Objetos de atributos sin Proxy.** Claves compartidas como accessors (un par por nombre, cacheado) con valores en un registro oculto; lectura directa tipo objeto plano (Object.keys ~575 → ~81 ns medidos en micro) y escrituras directas que siguen llegando al registro. Las cadenas calientes de `walk with fields` bajaron de 6,9 a 3,5 ms. `__proto__` sigue siendo propiedad de datos; los symbols de metadata son no enumerables. Detalle en [objetos de atributos](./PERFORMANCE-INVESTIGATION.md#attribute-objects-without-a-proxy).
- **Exportación del árbol con IDs globales en Rust.** La exportación evita el ciclo JS de parsear, copiar y volver a serializar JSON. En 30 pares: 1,943× total y 3,075× operación, con menor RSS mediano. Detalle en [exportación global](./PERFORMANCE-INVESTIGATION.md#native-global-id-export).
- **Preparación HTML en una pasada.** Fusionó asignación de IDs, mapa inverso y conteo de bytes retenidos. En 30 pares: carga sintética 1,063×; preparación de documento bajó 69 % en el diagnóstico por fases. La mejora en páginas reales fue pequeña.
- **Inicio de recorridos grandes con snapshot compacto.** Evita lecturas individuales del árbol al comenzar; la comparación con la versión inmediatamente anterior fue de alrededor de 1,03×, demasiado pequeña para explicar el costo general del recorrido.
- **IDs de hijos pequeños en línea para árboles mutables.** Mejoró carga, serialización y materialización XML en torno a 1,05–1,08× en las pruebas indicadas. El control HTML fue inconcluso.
- **Comparación de etiquetas de cierre sin copiar texto cuando se puede tomar prestado.** Mejoró XML y la configuración pública de htmlparser2; HTML estándar quedó cerca de paridad.
- **Extracción y serialización en páginas reales.** En una muestra de diez páginas, la extracción y serialización superaron 1,5× total en todas las filas registradas. Es una muestra pequeña del mismo archivo de Common Crawl, no una garantía universal.
- **Transporte UTF-16 y JSON.** Se mantuvieron las pruebas de equivalencia para surrogates aislados y pares. `encodeJson`/`decodeJson` transforman solo tokens que contienen valores problemáticos; `bench/json-diagnostics.mjs` mide parseos y serializaciones restantes sin usarse para medir tiempos.

Las razones y límites están detallados en el historial. Las mejoras que solo rozan paridad no se presentan como evidencia de 1,5×.

## Experimentos descartados

Se midieron y retiraron para no conservar complejidad ni regresiones:

- Accesores de hijos con fast path inline y constructores de vista alternativos, incluidos mapas de descriptores y `new`.
- Búsqueda de constructor directa en el bucle de snapshot y especialización del llenado de listas de hijos.
- Constructor con campos omitidos para nodos hoja.
- Vistas con literal de objeto y prototipos modernos aplanados.
- Manejador de proxy de atributos de forma fija.
- Umbrales alternativos de selección, capacidad inicial del árbol y asignadores mimalloc.

Las mediciones pareadas, intervalos, igualdad de resultados y motivos de rechazo están en las secciones «Rejected experiment» del [historial de investigación](./PERFORMANCE-INVESTIGATION.md). En particular, los recorridos de 2.000 tarjetas fueron 0,48× (`walk children`) y 0,26× (`walk with fields`) en una comparación de 21 muestras; los cambios locales de construcción no resolvieron la brecha.

## Trabajo pendiente, por prioridad

### P0 — Cerrar la brecha de recorridos JS

La brecha de los recorridos ya no está en la lectura de `children` (el recorrido caliente es más rápido que Cheerio) sino en la **materialización**: el primer recorrido crea ~32 mil vistas y ~32 mil listas de hijos (5,6 ms de operación a 2.000 tarjetas) y `walk with fields` añade la materialización de objetos de atributos (21,9 ms op.). Los microcambios de constructores y cachés ya probados no movieron ese costo. La aritmética muestra además que la carga domina: con carga a 12,6 ms en el fixture de 494 KB, `walk children` no puede alcanzar 1,5× total aunque su operación costara cero. Las dos vías medidas que quedan: (1) adelgazar el sink de scraper — el experimento midió 8,8 ms frente a 11,6 ms de parseo en el fixture de 494 KB, ~2,8 ms disponibles, con lo que `walk children` queda a ~1,49× y las tres cadenas de selección (1,43–1,48×) cruzan 1,5×; y (2) baratizar la materialización por nodo (vista + lista de hijos + objeto de atributos), donde `walk with fields` necesita llegar a ~13 ms de operación y las alternativas de construcción ya rechazadas no bastan: hace falta una decisión de arquitectura sobre quién es dueño de los objetos, con los mismos controles de identidad y mutación.

**Aceptación:** `walk children` y `walk with fields` deben mejorar en comparaciones pareadas; el gate debe pasar consistentemente; las formas y mutaciones del DOM deben seguir equivalentes.

### P1 — Eliminar operaciones bajo paridad y acercar todas a 1,5×

Con la carga a 1,76×, quedan bajo 1,5× total a 2.000 tarjetas: las tres cadenas de selección (1,43–1,48×), los dos recorridos JS (1,32×, 0,74×) y la reescritura de atributos por elemento (1,32×). Todas comparten la causa raíz de P0 (materialización por nodo), así que ambos frentes convergen. El objetivo acordado sigue siendo 1,5× total por operación, no solo una mejora aislada en el tramo cronometrado.

### P2 — Verificar cargas representativas y regresiones

- Ejecutar la matriz HTML, XML y htmlparser2 a 200 y 2.000 tarjetas, además de páginas reales; ampliar la muestra real más allá de las diez páginas del mismo WARC.
- Usar al menos 30 pares alternados para decisiones de rendimiento importantes, intervalos bootstrap y igualdad completa de resultados. Hecho en esta ronda: 30 pares HTML de todas las operaciones y 60 pares XML enfocados contra la cabeza del PR, con igualdad de salida verificada por V8 serialization en cada par.
- Medir memoria retenida y picos por separado; no inferir memoria de una sola lectura de RSS.
- Mantener controles de carga sola y de operaciones rápidas para detectar regresiones causadas por optimizaciones de rutas lentas. Los op-only de XML (atributos 0,788×, recorrido con campos 1,027×) quedan documentados como el costo de materialización del nuevo diseño de atributos, compensado por lecturas ~4× más baratas.

### P3 — Cierre de entrega

- Ejecutar el gate, suite Node, tipos, pruebas Rust, compatibilidad legacy y prueba de paquete sobre el build final. Estado de esta ronda: el gate pasa en HTML y XML; 532 pruebas JS, 60 pruebas Rust, 58/58 diferenciales y 777/777 upstream pasan; legacy queda en 576 con un fallo preexistente documentado que también falla en la cabeza del PR.
- Auditar el estado de CI del PR y subir el resultado final a la misma rama/PR cuando las mediciones y verificaciones estén cerradas.
- Publicar una tabla final con build base, build candidato, sistema, versión de Node/Rust, entradas, intervalos y cualquier operación que no alcance la meta.

## Criterio de finalización

El plan no se considera terminado hasta que la matriz acordada alcance **1,5× total en todas las operaciones representativas**, no haya regresiones según comparaciones pareadas, el gate y las suites pasen en el build final, y el resultado esté actualizado en el PR. Si el rendimiento de un recorrido genérico de JavaScript impide cumplir la meta, debe quedar resuelto por una decisión de arquitectura validada; no se debe rebajar el umbral ni excluir esa operación para declarar éxito.
