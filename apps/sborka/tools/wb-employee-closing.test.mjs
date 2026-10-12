import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const backend = fs.readFileSync(path.join(root, "apps/WB/server.mjs"), "utf8");
const frontend = fs.readFileSync(
  path.join(root, "apps/sborka/dist/js/app.20260402-no-fbs-tab-v1.js"),
  "utf8"
);
const wbStorage = fs.readFileSync(path.join(root, "apps/WB/server/services/s3.mjs"), "utf8");
const ozStorage = fs.readFileSync(path.join(root, "apps/OZ/server/services/s3.mjs"), "utf8");

test("WB employee closing is permissioned and requires all orders", () => {
  assert.match(backend, /allow_employee_close boolean/);
  assert.match(backend, /settings\.allow_employee_close !== true/);
  assert.match(backend, /collected < total/);
  assert.match(backend, /supply_access_users where supply_id = \$1 and user_id = \$2/);
});

test("WB delivery requires an explicit irreversible confirmation", () => {
  const confirmations = backend.match(/confirmIrreversible !== true/g) || [];
  assert.ok(confirmations.length >= 2, "admin and employee delivery must both require confirmation");
  assert.match(frontend, /После передачи в доставку нельзя добавить, убрать или перенести заказы/);
});

test("employee closing UI exposes cargo, delivery, QR, print and completion actions", () => {
  for (const id of [
    "btn-employee-closing-trbx",
    "btn-employee-closing-deliver",
    "btn-employee-closing-barcode",
    "btn-employee-print-trbx",
    "btn-employee-print-supply",
    "btn-employee-closing-complete",
  ]) {
    assert.ok(frontend.includes(id), `missing ${id}`);
  }
  assert.match(frontend, /employee\/supplies\/\$\{encodeURIComponent\(supply\.id\)\}\/closing/);
});

test("new WB and Ozon PDFs are written to local server storage", () => {
  for (const storage of [wbStorage, ozStorage]) {
    assert.match(storage, /fs\.writeFileSync\(filePath/);
    assert.doesNotMatch(storage, /PutObjectCommand|S3Client/);
  }
});
