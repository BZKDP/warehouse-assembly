export const FLYER_QR_CODES = Object.freeze([
  "https://grafap.ru/?utm_source=qr&utm_medium=offline&utm_campaign=grafap_qr_2025_11",
  "https://taplink.cc/graflab?utm_source=ofline&utm_medium=newbook&utm_campaign=gift",
]);

const acceptedFlyerQr = new Map([
  ["grafap.ru|/|grafap_qr_2025_11|qr|offline", FLYER_QR_CODES[0]],
  ["taplink.cc|/graflab|gift|ofline|newbook", FLYER_QR_CODES[1]],
]);

export function normalizeFlyerQr(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const key = [
      host,
      path,
      url.searchParams.get("utm_campaign") || "",
      url.searchParams.get("utm_source") || "",
      url.searchParams.get("utm_medium") || "",
    ].join("|");
    return acceptedFlyerQr.get(key) || null;
  } catch {
    return null;
  }
}

export function isFlyerQr(value) {
  return normalizeFlyerQr(value) !== null;
}
