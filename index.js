// HTML to PDF Service using Express and Puppeteer
// Provides two endpoints:
// 1) /generate-pdf/isolated  -> launches a new single-use browser per request (isolation & consistency)
// 2) /generate-pdf/optimized -> uses one persistent browser and a new page per request (performance)

const express = require("express");
const puppeteer = require("puppeteer");

// Ensure Puppeteer uses a predictable cache dir if not configured (helps on hosts like Render)
process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || require("path").join(process.cwd(), ".cache", "puppeteer");

const PORT = process.env.PORT || 3000;
const app = express();

// Trust reverse proxies (Render, etc.) so req.ip and req.protocol honor X-Forwarded-* headers
app.set("trust proxy", true);

// Lightweight logger: JSON on Render or when LOG_FORMAT=json, else text
const LOG_FORMAT = (
  process.env.LOG_FORMAT || (process.env.RENDER ? "json" : "text")
).toLowerCase();
function logLine(level, msg, extra) {
  const base = { time: new Date().toISOString(), level, msg };
  const payload =
    extra && typeof extra === "object" ? { ...base, ...extra } : base;
  if (LOG_FORMAT === "json") {
    try {
      console.log(JSON.stringify(payload));
    } catch (_) {
      console.log(JSON.stringify({ time: base.time, level, msg }));
    }
  } else {
    const fields =
      extra && typeof extra === "object" ? ` ${JSON.stringify(extra)}` : "";
    console.log(`[${base.time}] ${level.toUpperCase()} ${msg}${fields}`);
  }
}
const log = {
  info: (msg, extra) => logLine("info", msg, extra),
  warn: (msg, extra) => logLine("warn", msg, extra),
  error: (msg, extra) => logLine("error", msg, extra),
};

// Simple request ID + timing middleware for heavy logging and tracing (run BEFORE body parsers)
function genReqId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

app.use((req, res, next) => {
  // Correlation / Request ID: accept from headers or generate; always echo back
  const incomingId =
    (req.headers["x-request-id"] ||
      req.headers["x-correlation-id"] ||
      req.headers["traceparent"]) ??
    null;
  if (incomingId && typeof incomingId === "string") {
    req.reqId = incomingId.split(",")[0].trim();
  } else {
    req.reqId = req.reqId || genReqId();
  }
  res.setHeader("X-Request-Id", req.reqId);

  const start = process.hrtime.bigint();
  const now = new Date().toISOString();
  const ct = req.headers["content-type"] || "(none)";
  const clen = req.headers["content-length"] || "-";
  const ua = req.headers["user-agent"] || "-";
  const ip =
    (req.headers["x-forwarded-for"] &&
      String(req.headers["x-forwarded-for"]).split(",")[0].trim()) ||
    req.ip ||
    req.socket?.remoteAddress ||
    "-";

  log.info("request", {
    reqId: req.reqId,
    ip,
    method: req.method,
    url: req.originalUrl,
    ct,
    len: clen,
    ua,
    t: now,
  });

  const logFinish = () => {
    const durMs = Number(process.hrtime.bigint() - start) / 1e6;
    const respBytes = res.get("Content-Length") || "-";
    const respCT = res.get("Content-Type") || "-";
    log.info("response", {
      reqId: req.reqId,
      status: res.statusCode,
      ms: Number(durMs.toFixed(1)),
      bytes: respBytes,
      type: respCT,
    });
  };
  res.on("finish", logFinish);
  res.on("close", () => {
    if (!res.writableEnded) {
      const durMs = Number(process.hrtime.bigint() - start) / 1e6;
      log.warn("connection_aborted", {
        reqId: req.reqId,
        ms: Number(durMs.toFixed(1)),
      });
    }
  });
  next();
});

// Parse JSON bodies (increase limit to handle large HTML payloads)
app.use(express.json({ limit: "10mb" }));
// Also accept URL-encoded bodies for convenience (e.g., Postman x-www-form-urlencoded)
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// Also accept raw text/html payloads where the entire body is the HTML to render
app.use(
  express.text({
    // Accept common text bodies and some mis-specified types used by clients
    type: (req) => {
      const ct = (req.headers["content-type"] || "").toLowerCase();
      return (
        ct.startsWith("text/") ||
        ct.includes("text/html") ||
        ct.includes("application/xhtml+xml") ||
        ct.includes("application/octet-stream")
      );
    },
    limit: "10mb",
  })
);

// Optional: lightweight health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Body parser error handler (invalid JSON, payload too large, etc.)
app.use((err, req, res, next) => {
  if (!err) return next();
  const id = (req && req.reqId) || "-";
  const msg = err && (err.message || String(err));
  log.error("parser_error", { reqId: id, message: msg });
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON", details: msg });
  }
  return res.status(400).json({ error: "Bad Request", details: msg });
});

// Standardized Puppeteer launch options
// Note: --no-sandbox flags are commonly needed in containerized hosts; harmless locally
const PUPPETEER_LAUNCH_OPTIONS = {
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
};

// --------------------------------------------------------------------------------------
// Persistent Browser (for /generate-pdf/optimized)
// --------------------------------------------------------------------------------------
let persistentBrowser = null;
let persistentBrowserLaunchPromise = null;

async function launchPersistentBrowser() {
  // Avoid relaunch if an active connection already exists
  if (persistentBrowser && persistentBrowser.isConnected()) {
    console.log("[persist] Reusing existing persistent browser");
    return persistentBrowser;
  }
  // Deduplicate concurrent launches
  if (persistentBrowserLaunchPromise) {
    console.log("[persist] Awaiting ongoing persistent browser launch...");
    return persistentBrowserLaunchPromise;
  }

  persistentBrowserLaunchPromise = puppeteer
    .launch(PUPPETEER_LAUNCH_OPTIONS)
    .then((browser) => {
      persistentBrowser = browser;
      // Reset reference if the browser disconnects (e.g., crash or manual close)
      browser.on("disconnected", () => {
        console.warn("[persist] Persistent browser disconnected");
        persistentBrowser = null;
      });
      console.log("[persist] Persistent browser launched");
      return browser;
    })
    .finally(() => {
      persistentBrowserLaunchPromise = null;
    });

  return persistentBrowserLaunchPromise;
}

// --------------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------------
function withTimeout(promise, ms, message = "Operation timed out") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

// Sanitize a requested filename to a safe PDF name
function safeFilename(input, fallback = "document.pdf") {
  if (!input || typeof input !== "string") return fallback;
  let name = input.trim();
  // Replace unsafe characters, collapse spaces, and strip path separators
  name = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
  name = name.replace(/[\\/]+/g, "_");
  if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
  if (name === ".pdf" || name === "") return fallback;
  return name;
}

async function renderPdfFromHtml(html, browser, reqId = "-") {
  console.log(`[${reqId}] [render] Opening new page`);
  const page = await browser.newPage();
  page.setDefaultTimeout(30000); // 30s default timeout for page operations

  try {
    // Load the HTML and wait for network to be idle to stabilize rendering
    console.log(
      `[${reqId}] [render] Setting page content (waitUntil=networkidle0)`
    );
    await withTimeout(
      (async () => {
        await page.setContent(html, { waitUntil: "networkidle0" });
        await page.emulateMediaType("screen");
      })(),
      25000,
      "Timed out while setting page content"
    );
    console.log(`[${reqId}] [render] Content set`);

    // Generate the PDF buffer
    console.log(`[${reqId}] [render] Generating PDF`);
    const pdfBuffer = await withTimeout(
      page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
      }),
      20000,
      "Timed out while generating PDF"
    );
    console.log(
      `[${reqId}] [render] PDF generated (${pdfBuffer.length} bytes)`
    );

    return { pdfBuffer, page };
  } catch (err) {
    // Close the page immediately on failure to avoid leaks
    try {
      console.warn(`[${reqId}] [render] Error encountered; closing page`);
      await page.close({ runBeforeUnload: false });
    } catch (_) {}
    throw err;
  }
}

function sendPdfBuffer(res, buffer, filename = "document.pdf") {
  const sigOk =
    buffer && buffer.length >= 5 && buffer.toString("ascii", 0, 5) === "%PDF-";
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(buffer.length),
    "Cache-Control": "no-store",
    "Content-Transfer-Encoding": "binary",
  });
  if (!sigOk) {
    // This shouldn't occur; log for diagnostics but still send the data
    try {
      log.warn("pdf_signature_missing", { len: buffer?.length });
    } catch (_) {}
  }
  res.status(200).end(buffer);
}

function ensureHtmlInput(req, res) {
  const ct = req.headers["content-type"] || "";
  let html = null;

  // If body parser provided a string (text/plain or text/html), treat it as the HTML directly
  if (typeof req.body === "string") {
    html = req.body;
  } else if (req && req.body && typeof req.body === "object") {
    html = req.body.html;
  }

  if (typeof html !== "string" || html.trim() === "") {
    const keys =
      req && req.body && typeof req.body === "object"
        ? Object.keys(req.body)
        : [];
    return res.status(400).json({
      error: "Expected HTML input",
      details: {
        message:
          'Send raw text/html body or JSON with a non-empty string property "html".',
        contentType: ct || "(none)",
        receivedType: typeof req.body,
        bodyKeys: keys,
      },
    });
  }

  const length = Buffer.byteLength(html, "utf8");
  log.info("validated_html", { reqId: req.reqId, bytes: length });
  return html;
}

// Helpful GET handlers to explain correct usage instead of ambiguous 404/400
function methodNotAllowedInfo(req, res) {
  return res.status(405).json({
    error: "Method Not Allowed",
    details: {
      method: req.method,
      use: 'POST with application/json { "html": "..." } or text/html|text/plain body containing the HTML',
      path: req.originalUrl,
    },
  });
}

// --------------------------------------------------------------------------------------
// Endpoint 1: Isolated mode - launches a new single-use browser per request
// --------------------------------------------------------------------------------------
app.get("/generate-pdf/isolated", methodNotAllowedInfo);
app.post("/generate-pdf/isolated", async (req, res) => {
  const html = ensureHtmlInput(req, res);
  if (html === null) return;

  let browser = null;
  let page = null;

  try {
    log.info("isolated_launch_browser", { reqId: req.reqId });
    browser = await puppeteer.launch(PUPPETEER_LAUNCH_OPTIONS);
    log.info("isolated_browser_launched", { reqId: req.reqId });
    const { pdfBuffer, page: createdPage } = await renderPdfFromHtml(
      html,
      browser,
      req.reqId
    );
    page = createdPage;

    // Clean up browser and page right after the response is sent
    res.on("finish", async () => {
      try {
        if (page && !page.isClosed()) {
          log.info("isolated_close_page_finish", { reqId: req.reqId });
          await page.close({ runBeforeUnload: false });
        }
      } catch (_) {}
      try {
        if (browser) {
          log.info("isolated_close_browser_finish", { reqId: req.reqId });
          await browser.close();
        }
      } catch (_) {}
    });

    const filename = safeFilename(req.query && req.query.filename);
    log.info("isolated_send_pdf", {
      reqId: req.reqId,
      bytes: pdfBuffer.length,
      filename,
    });
    sendPdfBuffer(res, pdfBuffer, filename);
  } catch (err) {
    // On error, attempt immediate cleanup since response might not be sent
    try {
      if (page && !page.isClosed()) {
        log.warn("isolated_error_close_page", { reqId: req.reqId });
        await page.close({ runBeforeUnload: false });
      }
    } catch (_) {}
    try {
      if (browser) {
        log.warn("isolated_error_close_browser", { reqId: req.reqId });
        await browser.close();
      }
    } catch (_) {}

    if (!res.headersSent) {
      log.error("isolated_error", {
        reqId: req.reqId,
        error: err?.message || String(err),
      });
      res.status(500).json({
        error: "Failed to generate PDF (isolated)",
        details: err.message,
      });
    }
  }
});

// --------------------------------------------------------------------------------------
// Endpoint 2: Optimized mode - uses one persistent browser, a new page per request
// --------------------------------------------------------------------------------------
app.get("/generate-pdf/optimized", methodNotAllowedInfo);
app.post("/generate-pdf/optimized", async (req, res) => {
  const html = ensureHtmlInput(req, res);
  if (html === null) return;

  let page = null;

  try {
    log.info("optimized_get_browser", { reqId: req.reqId });
    const browser = await launchPersistentBrowser();
    const { pdfBuffer, page: createdPage } = await renderPdfFromHtml(
      html,
      browser,
      req.reqId
    );
    page = createdPage;

    // Close only the page after the response is sent; keep the browser alive
    res.on("finish", async () => {
      try {
        if (page && !page.isClosed()) {
          log.info("optimized_close_page_finish", { reqId: req.reqId });
          await page.close({ runBeforeUnload: false });
        }
      } catch (_) {}
    });

    const filename = safeFilename(req.query && req.query.filename);
    log.info("optimized_send_pdf", {
      reqId: req.reqId,
      bytes: pdfBuffer.length,
      filename,
    });
    sendPdfBuffer(res, pdfBuffer, filename);
  } catch (err) {
    try {
      if (page && !page.isClosed()) {
        log.warn("optimized_error_close_page", { reqId: req.reqId });
        await page.close({ runBeforeUnload: false });
      }
    } catch (_) {}
    if (!res.headersSent) {
      log.error("optimized_error", {
        reqId: req.reqId,
        error: err?.message || String(err),
      });
      res.status(500).json({
        error: "Failed to generate PDF (optimized)",
        details: err.message,
      });
    }
  }
});

// --------------------------------------------------------------------------------------
// Server startup
// --------------------------------------------------------------------------------------
(async () => {
  try {
    // Start listening immediately to satisfy Render's port binding checks
    const server = app.listen(PORT, "0.0.0.0", () => {
      log.info("startup_listening", {
        host: "0.0.0.0",
        port: PORT,
        portEnv: process.env.PORT || "unset",
      });
      log.info("startup_endpoints", {
        endpoints: [
          { method: "POST", path: "/generate-pdf/isolated" },
          { method: "POST", path: "/generate-pdf/optimized" },
        ],
      });
      if (process.env.RENDER) {
        log.info("startup_render_env", {
          service: process.env.RENDER_SERVICE_NAME || "?",
          region: process.env.RENDER_REGION || "?",
        });
      }
      // Launch the persistent browser after the port is bound
      (async () => {
        log.info("startup_launch_browser");
        try {
          await launchPersistentBrowser();
        } catch (e) {
          log.error("startup_browser_error", {
            error: e?.message || String(e),
          });
        }
      })();
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      log.warn("shutdown_signal", { signal });
      server.close(() => log.info("shutdown_http_closed"));
      try {
        if (persistentBrowser) {
          log.info("shutdown_closing_browser");
          await persistentBrowser.close();
        }
      } catch (_) {}
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    console.error(
      "Failed to start service:",
      err && (err.stack || err.message || err)
    );
    process.exit(1);
  }
})();

// Fallback for unsupported methods on the generate-pdf routes
app.all(["/generate-pdf/isolated", "/generate-pdf/optimized"], (req, res) => {
  if (req.method !== "POST") return methodNotAllowedInfo(req, res);
  res.status(404).json({ error: "Not Found" });
});
