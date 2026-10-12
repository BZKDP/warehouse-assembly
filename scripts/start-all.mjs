import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(path.join(rootDir, ".env"));

// ---------------------------------------------------------------------------
// Persistent file logging (for operators/AI to self-diagnose without journald).
// Everything all three services print to stdout/stderr is also appended to
// logs/app.log with an ISO timestamp. Read it with:
//   tail -n 200 /opt/grasklad-sborka/logs/app.log
//   grep -iE 'error|timeout|\[req\]' /opt/grasklad-sborka/logs/app.log | tail
// ---------------------------------------------------------------------------
const logDir = path.join(rootDir, "logs");
let logStream = null;
try {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "app.log");
  // simple rotation: keep the file bounded (~20MB) so it never fills the disk
  try {
    const st = fs.statSync(logFile);
    if (st.size > 20 * 1024 * 1024) fs.renameSync(logFile, path.join(logDir, "app.log.old"));
  } catch {}
  logStream = fs.createWriteStream(logFile, { flags: "a" });
} catch (error) {
  console.error(`[launcher] file logging disabled: ${error?.message || error}`);
}

function fileLog(line) {
  if (!logStream) return;
  try {
    logStream.write(`${new Date().toISOString()} ${line}`);
  } catch {}
}

const apps = [
  { name: "oz", cwd: path.join(rootDir, "apps", "OZ"), script: "server.mjs", startupDelayMs: 0 },
  { name: "wb", cwd: path.join(rootDir, "apps", "WB"), script: "server.mjs", startupDelayMs: 0 },
  { name: "sborka", cwd: path.join(rootDir, "apps", "sborka"), script: "server.mjs", startupDelayMs: 1200 },
];

const children = new Map();
let shuttingDown = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prefixStream(name, stream, output) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line) {
        const out = `[${name}] ${line}\n`;
        output.write(out);
        fileLog(out);
      }
    }
  });
  stream.on("end", () => {
    if (buffer) {
      const out = `[${name}] ${buffer}\n`;
      output.write(out);
      fileLog(out);
    }
  });
}

function startApp(app) {
  const child = spawn(process.execPath, [app.script], {
    cwd: app.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  children.set(app.name, child);
  prefixStream(app.name, child.stdout, process.stdout);
  prefixStream(app.name, child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    children.delete(app.name);
    if (shuttingDown) return;
    console.error(`[launcher] ${app.name} exited with code=${code ?? "null"} signal=${signal ?? "null"}`);
    shutdown(code || 1);
  });

  console.log(`[launcher] started ${app.name} pid=${child.pid}`);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [name, child] of children.entries()) {
    console.log(`[launcher] stopping ${name} pid=${child.pid}`);
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 2500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

for (const app of apps) {
  if (app.startupDelayMs) await wait(app.startupDelayMs);
  startApp(app);
}
