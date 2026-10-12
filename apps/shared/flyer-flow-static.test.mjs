import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apps = path.resolve(here, "..");
const read = (...parts) => fs.readFileSync(path.join(apps, ...parts), "utf8");

test("WB and Ozon persist flyer confirmation and gate label scan", () => {
  const wb = read("WB", "server.mjs");
  const oz = read("OZ", "server.mjs");
  for (const source of [wb, oz]) {
    assert.match(source, /flyer_scan_passed_at = now\(\)/);
    assert.match(source, /code: "FLYER_SCAN_REQUIRED"/);
    assert.match(source, /normalizeFlyerQr/);
    assert.match(source, /completed\?\.flyer_scan_passed_at/);
    assert.match(source, /reused: true/);
  }
  assert.match(wb, /dispenser_mode === true/);
  assert.match(oz, /EMPLOYEE_WORKFLOW_MODE_INSTANT/);
});

test("unified UI renders flyer scan before label scan in both flows", () => {
  const source = read("sborka", "dist", "js", "app.20260402-no-fbs-tab-v1.js");
  assert.match(source, /id="instant-flyer-scan-\$\{mp\}"/);
  assert.match(source, /id="wb-dispenser-flyer-scan"/);
  assert.match(source, /openOrder\.flyerScanPassedAt \? instantLabelScan/);
  assert.match(source, /if \(!order\.flyerScanPassedAt\)/);
});

test("unified proxy exposes flyer scan for WB and Ozon", () => {
  const source = read("sborka", "server.mjs");
  assert.match(source, /oz\/employee\/assemblies\/:assemblyId\/orders\/:postingNumber\/flyer-scan/);
  assert.match(source, /wb\/employee\/supplies\/:supplyId\/orders\/:orderId\/flyer-scan/);
});
