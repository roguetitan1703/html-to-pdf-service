# HTML to PDF Service (Express + Puppeteer)

Two endpoints to convert HTML to PDF:

- POST `/generate-pdf/isolated` → new single-use browser per request (isolation, consistency)
- POST `/generate-pdf/optimized` → persistent browser, new page per request (performance)

## Quick start

1. Install

```bash
npm install
```

2. Run

```bash
npm start
```

3. Health check

```bash
curl -fsS http://localhost:${PORT:-3000}/health
```

## Usage

Send HTML as JSON:

```bash
curl -X POST "http://localhost:${PORT:-3000}/generate-pdf/optimized?filename=Sample.json.pdf" \
  -H "Content-Type: application/json" \
  -d '{"html":"<!doctype html><html><body><h1>Hello</h1></body></html>"}' \
  --output Sample.json.pdf
```

Or raw HTML body:

```bash
curl -X POST "http://localhost:${PORT:-3000}/generate-pdf/isolated?filename=Sample.html.pdf" \
  -H "Content-Type: text/html" \
  --data-binary "<!doctype html><html><body><h1>Hello</h1></body></html>" \
  --output Sample.html.pdf
```

Notes:

- Add `?filename=YourFile.pdf` to control the download name (sanitized).
- Response is forced download (attachment; binary) with `Content-Length` and signature check.

## Logging

- Defaults to JSON logs on Render (or when `LOG_FORMAT=json`), text locally.
- Request log includes: reqId, ip, method, url, ct, len, ua.
- Response log includes: status, duration (ms), response type, bytes.
- Aborted connections and parser errors are logged.

You can propagate an ID via `X-Request-Id` (or `X-Correlation-Id`); it’s echoed back.

## Render deployment

- Environment: Render will provide `PORT` automatically; we bind on `0.0.0.0:PORT`.
- Optional env: `LOG_FORMAT=json` to force JSON logs.
- Health check: `GET /health`
- Build: `npm install`
- Start: `node index.js`

## n8n integration

Use an HTTP Request node:

- Method: POST
- URL: `https://<your-service>.onrender.com/generate-pdf/optimized?filename={{$json.filename || 'document.pdf'}}`
- Headers: `Content-Type: application/json`, optional `X-Request-Id: {{$json.requestId}}`
- Body (JSON): `{ "html": "{{$json.html}}" }`
- Response: set "Response Format" to "File" or "Binary Data" (property name `data`/`pdf`).

Raw HTML variant:

- Headers: `Content-Type: text/html`
- Body: `{{$json.html}}`

## Development

- `test-client.js` sends JSON or raw HTML and saves PDFs locally.
- `LOG_FORMAT=text` for human-friendly logs.

## Security

- Puppeteer runs with `--no-sandbox` flags for container environments; adjust if your host supports sandboxing.
- Consider rate limits and auth for public deployment.
