#!/usr/bin/env node
// Simple Node test client to POST JSON or raw HTML to the PDF service and save the PDF.
// Usage examples:
//   node test-client.js --mode optimized --type json --out out.pdf --filename MyDoc.pdf --html "<html>...</html>"
//   node test-client.js --mode isolated --type html --out out2.pdf --html "<html>...</html>"
// If run without args, it will run two smoke tests (optimized/json and isolated/html).

const http = require("http");
const fs = require("fs");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    let a = argv[i];
    if (a.startsWith("--")) {
      a = a.slice(2);
      const eq = a.indexOf("=");
      if (eq >= 0) {
        out[a.slice(0, eq)] = a.slice(eq + 1);
      } else {
        const key = a;
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          out[key] = next;
          i++;
        } else {
          out[key] = true;
        }
      }
    }
  }
  return out;
}

function now() {
  return new Date().toISOString();
}

function runOnce({
  host = "localhost",
  port = 3000,
  mode = "optimized", // or 'isolated'
  type = "json", // 'json' | 'html' | 'text'
  html,
  out = "out.pdf",
  filename = "document.pdf",
}) {
  return new Promise((resolve, reject) => {
    const path = `/generate-pdf/${mode}?filename=${encodeURIComponent(
      filename
    )}`;
    let body;
    let contentType;
    if (type === "json") {
      contentType = "application/json";
      const payload = { html };
      body = Buffer.from(JSON.stringify(payload), "utf8");
    } else if (type === "html") {
      contentType = "text/html";
      body = Buffer.from(html, "utf8");
    } else {
      contentType = "text/plain";
      body = Buffer.from(html, "utf8");
    }

    const options = {
      host,
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const chunks = [];
    const req = http.request(options, (res) => {
      const { statusCode, headers } = res;
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (statusCode !== 200) {
          const text = buf.toString("utf8");
          return reject(
            new Error(
              `HTTP ${statusCode} ${headers["content-type"] || ""} -> ${text}`
            )
          );
        }
        fs.writeFileSync(out, buf);
        const sig = buf.slice(0, 4);
        console.log(
          `[${now()}] Saved ${out} (${
            buf.length
          } bytes). Signature bytes: ${Array.from(sig).join(",")}`
        );
        console.log(
          `Headers -> CT: ${headers["content-type"]} CL: ${headers["content-length"]}`
        );
        resolve({ out, size: buf.length, headers });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const host = args.host || "localhost";
  const port = Number(args.port || 3000);
  const mode = (args.mode || "optimized").toLowerCase();
  const type = (args.type || "json").toLowerCase();
  const filename = args.filename || "document.pdf";
  const out = args.out || `out-${mode}-${type}.pdf`;
  const htmlArg = args.html;
  const htmlDefault = `<!doctype html><html><head><meta charset=\"utf-8\"><title>Test</title><style>body{font-family:Arial,sans-serif}</style></head><body><h1>Hello PDF</h1><p>${now()}</p></body></html>`;
  const html = htmlArg || htmlDefault;

  if (args.help) {
    console.log(
      `Usage: node test-client.js [--mode optimized|isolated] [--type json|html|text] [--filename Name.pdf] [--out path] [--html '<html>...'] [--host localhost] [--port 3000]`
    );
    process.exit(0);
  }

  if (process.argv.length > 2) {
    // Single run based on args
    console.log(
      `Posting -> mode=${mode} type=${type} host=${host}:${port} filename=${filename} out=${out}`
    );
    try {
      await runOnce({ host, port, mode, type, html, out, filename });
    } catch (err) {
      console.error("Request failed:", err.message);
      process.exit(1);
    }
    return;
  }

  // Default: two smoke tests
  console.log("No args supplied; running two smoke tests...");
  try {
    await runOnce({
      host,
      port,
      mode: "optimized",
      type: "json",
      html,
      out: "out-optimized-json.pdf",
      filename: "Optimized.json.pdf",
    });
    await runOnce({
      host,
      port,
      mode: "isolated",
      type: "html",
      html,
      out: "out-isolated-html.pdf",
      filename: "Isolated.html.pdf",
    });
  } catch (err) {
    console.error("Smoke test failed:", err.message);
    process.exit(1);
  }
}

main();
