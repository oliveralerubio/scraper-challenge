# Quality checks

Este proyecto incluye checks reproducibles para demostrar que el scraper funciona
contra el sitio alternativo sin VPN (`OEFA`) y que respeta la restriccion de no
usar automatizacion de navegador.

## Comando principal

```bash
npm run quality
```

Este comando ejecuta:

```bash
npm run build
npm run e2e:oefa
```

`npm test` apunta al mismo quality gate.

## Que valida el E2E de OEFA

El script `npm run e2e:oefa` corre una extraccion real contra:

```text
https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml
```

Parametros usados:

```bash
--target oefa --max-pages 1 --max-docs 1 --download-pdfs --out-dir out/e2e
```

Validaciones incluidas:

- GET inicial al sitio OEFA.
- Parseo de formulario JSF y campos ocultos.
- POST AJAX de busqueda inicial.
- Extraccion de al menos un documento.
- Extraccion de accion JSF `mojarra.jsfcljs(...)` con `param_uuid`.
- Descarga real de al menos un PDF.
- Validacion de magic bytes del PDF: `%PDF`.
- Validacion de que `out/e2e/oefa/oefa-resultados.jsonl` tenga al menos una fila.
- Validacion de campos minimos del documento (`source`, `summary`, `pdfUrl`).
- Validacion de que `out/e2e/oefa/oefa-fallos.json` sea JSON parseable.

Salida esperada del E2E:

```json
{
  "source": "oefa",
  "docsFound": 1,
  "pdfsDownloaded": 1,
  "validatedPdf": true
}
```

Los paths exactos pueden variar por entorno, pero se generan bajo:

```text
out/e2e/oefa/
out/e2e/oefa/pdfs/
```

## Checks adicionales recomendados

### Auditoria de dependencias

```bash
npm audit --audit-level=high
```

Resultado esperado al momento de preparar la entrega:

```text
found 0 vulnerabilities
```

### Verificacion de restriccion "sin navegador"

```bash
rg -n "puppeteer|playwright|selenium|webdriver|chromium|browserType|launch\\(" src package.json README.md
```

Resultado esperado:

```text
sin resultados
```

El proyecto usa `@crawlee/cheerio`, que trabaja con requests HTTP y Cheerio.
No usa `PlaywrightCrawler`, `PuppeteerCrawler`, Selenium ni WebDriver.

### Smoke test de PJ

```bash
npm run scrape -- --target pj --max-pages 1 --max-docs 1 --timeout-ms 12000
```

En redes sin acceso al portal PJ, el resultado esperado es exit code `0` y un
fallo controlado en:

```text
out/pj/pj-fallos.json
```

Ejemplo de fallo controlado:

```json
{
  "reason": "HTTP 403: bloqueo geografico/anti-bot, probar desde VPN Peru",
  "status": 403
}
```

Esto confirma que el scraper no crashea ni imprime un stacktrace confuso cuando
el sitio principal bloquea el acceso por red.

## Evidencia local de la ultima corrida

Ultima corrida local ejecutada el 2026-06-30:

```bash
npm run quality
npm audit --audit-level=high
rg -n "puppeteer|playwright|selenium|webdriver|chromium|browserType|launch\\(" src package.json README.md
npm run scrape -- --target pj --max-pages 1 --max-docs 1 --timeout-ms 12000
```

Resultados observados:

- `npm run quality`: paso.
- `npm run build`: paso.
- `npm run e2e:oefa`: paso con `docsFound: 1`, `pdfsDownloaded: 1`, `validatedPdf: true`.
- `npm audit --audit-level=high`: `found 0 vulnerabilities`.
- Busqueda de automatizacion de navegador: sin resultados.
- Smoke PJ: exit code `0`, con `HTTP 403` documentado en `out/pj/pj-fallos.json`.

Validacion manual de artefactos OEFA:

```json
{
  "jsonlRows": 1,
  "source": "oefa",
  "hasSummary": true,
  "pdfUrl": "jsf-postback",
  "pdfCount": 1,
  "firstPdfHeader": "%PDF",
  "failuresJsonValid": true
}
```
