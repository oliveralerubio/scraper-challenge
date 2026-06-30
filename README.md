# Scraper Challenge (TypeScript + Crawlee)

Scraper HTTP (sin navegador) para dos objetivos:

- `pj`: `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml`
- `oefa`: `https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml`

La implementación usa **`@crawlee/cheerio`** como base de crawling HTTP y parsing de HTML.

## Requisitos

- Node.js 18+
- `npm install`

## Instalación

```bash
npm install
```

## Uso

### Ejecutar con valores por defecto de PJ

```bash
npm run scrape -- --target pj --max-pages 3 --max-docs 50
```

### Ejecutar sobre OEFA

```bash
npm run scrape -- --target oefa --max-pages 3 --download-pdfs
```

### E2E de OEFA real (requerida)

```bash
npm run e2e:oefa
```

Este comando corre una corrida mínima de:

- `--target oefa`
- `--max-pages 1`
- `--max-docs 1`
- `--download-pdfs`

y valida:

- que exista un JSONL de resultados con al menos 1 fila,
- que se descargue al menos un PDF real (magic bytes `%PDF`),
- que la corrida termine sin excepción.

### Quality gate completo

```bash
npm run quality
```

Este comando corre `npm run build` y `npm run e2e:oefa`.
`npm test` ejecuta el mismo quality gate.

La evidencia detallada para evaluadores esta documentada en
[`docs/quality-checks.md`](docs/quality-checks.md).

### Opciones disponibles

- `--target pj|oefa`
- `--base-url` (opcional, reemplaza la URL base por defecto)
- `--out-dir` directorio de salida (`out` por defecto)
- `--max-pages` máximo de páginas a recorrer
- `--max-docs` máximo de documentos guardados
- `--download-pdfs` descargar PDFs vinculados
- `--delay-ms` pausa entre fases clave de request (GET/POST/PDF)
- `--pdf-concurrency` concurrencia de descargas PDF
- `--timeout-ms` timeout HTTP por request
- `--verbose` logs de detalle

## Estructura de salida

- `out/<target>/<target>-resultados.jsonl`: resultados normalizados por línea.
- `out/<target>/<target>-fallos.json`: resumen de fallos y metadata.
- `out/<target>/pdfs/`: archivos PDF descargados (si se habilita `--download-pdfs`).

## Estrategia ante `429`

- Reintento exponencial con backoff para respuestas `429`.
- Reintento también para errores transitorios y `5xx`.
- Respeto a `Retry-After` cuando lo entregue el servidor.
- Si se agota el reintento, se registra fallo en `*-fallos.json` y la corrida continúa.

## ¿Por qué no se usa Scrapling?

Este reto exige un flujo HTTP controlado, con manejo explícito de:

- sesiones/cookies,
- formularios JSF por `POST`,
- paginación AJAX con `javax.faces`,
- estrategia de reintento y fallback.

`Scrapling` no aporta esas capacidades de forma directa para este caso.

## OEFA / PJ por red

- OEFA normalmente funciona en entornos sin VPN.
- PJ puede requerir VPN Perú para acceso estable.
- Si PJ devuelve `403`, se registra un fallo claro con mensaje de bloqueo geográfico/anti-bot y se evita el stacktrace.

## Notas de funcionamiento OEFA

- GET inicial a `consultaTfa.xhtml`.
- POST AJAX de búsqueda en blanco:
  - fuente `listarDetalleInfraccionRAAForm:btnBuscar`,
  - `partial.render= listarDetalleInfraccionRAAForm:pgLista listarDetalleInfraccionRAAForm:txtNroexp`.
- Paginación AJAX usando `dt` con:
  - `dt_pagination=true`,
  - `dt_first`,
  - `dt_rows`,
  - `dt_encodeFeature=true`.
- Extracción de `javax.faces.ViewState` y `listarDetalleInfraccionRAAForm:dt_scrollState` desde updates.
- Extracción de PDFs de fila por `onclick` `mojarra.jsfcljs(...)` con `param_uuid`.

## Publicación GitHub

1. `git add .`
2. `git commit -m "feat: migrate scraper to @crawlee/cheerio and add OEFA e2e"`
3. `git push`
4. Abrir PR con evidencias:
   - `npm run quality`
   - `npm audit --audit-level=high`
   - ver [`docs/quality-checks.md`](docs/quality-checks.md)
