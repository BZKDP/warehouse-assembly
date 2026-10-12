import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import {
  PROJECT_ROOT,
  ROOT_SITE,
  S3_PUBLIC_BASE,
} from "../config.mjs";

const LOCAL_FILE_PREFIX = "_local";
const LOCAL_FILES_DIR = path.join(PROJECT_ROOT, "var", "public-files");
const LOCAL_FILES_BASE = `/${ROOT_SITE}/files`;

export function getLocalFilesDir() {
  return LOCAL_FILES_DIR;
}

export function isLocalStorageKey(key) {
  return String(key || "").startsWith(`${LOCAL_FILE_PREFIX}/`);
}

export function buildLocalStorageKey(key) {
  const normalized = String(key || "").replace(/^\/+/, "");
  return `${LOCAL_FILE_PREFIX}/${normalized}`;
}

export function resolveLocalFilePath(key) {
  const normalized = String(key || "").replace(/^\/+/, "");
  return path.join(LOCAL_FILES_DIR, normalized);
}

export function slugify(value) {
  if (!value) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function buildLabelsPrefix(supplyId, supplyName) {
  const name = slugify(supplyName || "");
  const base = name ? `${supplyId}-${name}` : String(supplyId || "").trim();
  return base || `supply-${Date.now()}`;
}

export function buildS3Key(prefix, orderId) {
  return `${prefix}/${orderId}.pdf`;
}

export function buildS3Url(key) {
  if (isLocalStorageKey(key)) {
    const safeLocal = String(key || "")
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    return `${LOCAL_FILES_BASE}/${safeLocal}`;
  }
  const safe = key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${S3_PUBLIC_BASE}/${safe}`;
}

export async function pngBase64ToPdf(base64) {
  const pngBytes = Buffer.from(base64, "base64");
  const pdfDoc = await PDFDocument.create();
  const image = await pdfDoc.embedPng(pngBytes);
  const { width, height } = image.scale(1);
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });
  return await pdfDoc.save();
}

export async function uploadPdfToS3(key, pdfBytes) {
  const localKey = buildLocalStorageKey(key);
  const filePath = resolveLocalFilePath(localKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(pdfBytes));
  return localKey;
}
