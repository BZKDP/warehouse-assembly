import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnv, mainDbConfig, pgSslMode, rootDir } from "./db-common.mjs";

loadEnv();

const config = mainDbConfig();
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
const backupDir = path.join(rootDir, "backups", stamp);
fs.mkdirSync(backupDir, { recursive: true });

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function runPgDump(args, outFile) {
  const env = {
    ...process.env,
    PGPASSWORD: config.password,
    PGSSLMODE: pgSslMode(config.sslMode),
  };
  const result = spawnSync(
    "pg_dump",
    [
      "--host",
      config.host,
      "--port",
      String(config.port),
      "--username",
      config.user,
      "--dbname",
      config.database,
      "--no-owner",
      "--no-privileges",
      ...args,
      "--file",
      outFile,
    ],
    { env, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`pg_dump failed for ${path.basename(outFile)}: ${result.stderr || result.stdout}`);
  }
  const stat = fs.statSync(outFile);
  return { file: outFile, bytes: stat.size, sha256: sha256(outFile) };
}

const schema = runPgDump(["--schema-only"], path.join(backupDir, "main-schema.sql"));
const affected = runPgDump(
  [
    "--data-only",
    "--column-inserts",
    "--table=public.users",
    "--table=public.supply_settings",
    "--table=public.ozon_assemblies",
  ],
  path.join(backupDir, "main-affected-data.sql")
);

const manifest = {
  createdAt: new Date().toISOString(),
  database: {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    sslMode: config.sslMode,
  },
  files: [schema, affected],
};

const manifestPath = path.join(backupDir, "manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ backupDir, files: manifest.files, manifest: manifestPath }, null, 2));
