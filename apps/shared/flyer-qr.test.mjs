import assert from "node:assert/strict";
import test from "node:test";
import { FLYER_QR_CODES, normalizeFlyerQr } from "./flyer-qr.mjs";

test("accepts both production flyer QR codes", () => {
  for (const code of FLYER_QR_CODES) assert.equal(normalizeFlyerQr(code), code);
});

test("accepts harmless URL normalization and query parameter order", () => {
  assert.equal(
    normalizeFlyerQr("https://www.grafap.ru/?utm_campaign=grafap_qr_2025_11&utm_medium=offline&utm_source=qr"),
    FLYER_QR_CODES[0]
  );
  assert.equal(
    normalizeFlyerQr("https://taplink.cc/graflab/?utm_campaign=gift&utm_source=ofline&utm_medium=newbook"),
    FLYER_QR_CODES[1]
  );
});

test("rejects unrelated or modified QR codes", () => {
  assert.equal(normalizeFlyerQr("https://example.com"), null);
  assert.equal(normalizeFlyerQr("https://grafap.ru/?utm_source=qr&utm_medium=offline&utm_campaign=wrong"), null);
  assert.equal(normalizeFlyerQr(""), null);
});
