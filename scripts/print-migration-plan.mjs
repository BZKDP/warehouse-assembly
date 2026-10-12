import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(rootDir, "migrations", "20260728_locations.sql");

console.log(fs.readFileSync(migrationPath, "utf8"));
