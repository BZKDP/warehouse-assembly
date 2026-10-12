import { Pool } from "pg";
import {
  SKLAD_CACHE_MS,
  SKLAD_DB_HOST,
  SKLAD_DB_NAME,
  SKLAD_DB_PASSWORD,
  SKLAD_DB_POOL_MAX,
  SKLAD_DB_PORT,
  SKLAD_DB_SSL,
  SKLAD_DB_USER,
  DB_POOL_CONNECTION_TIMEOUT_MS,
  SKLAD_FBS_WAREHOUSE_ID,
  SKLAD_FBS_WAREHOUSE_NAME,
} from "../config.mjs";
import { normalizeArticleKey, normalizeBarcode } from "../utils.mjs";

const lookupCache = new Map();
const stockCache = new Map();
const warehouseCache = new Map();
let poolPromise = null;

export function clearMsCaches() {
  lookupCache.clear();
  stockCache.clear();
  warehouseCache.clear();
}

function getCacheKey(kind, value) {
  return `${kind}:${value}`;
}

function getCachedValue(cache, cacheKey, force = false) {
  if (force) return null;
  const cached = cache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - Number(cached.ts || 0) >= SKLAD_CACHE_MS) return null;
  return cached.value;
}

function rememberValue(cache, cacheKey, value) {
  cache.set(cacheKey, { ts: Date.now(), value });
  return value;
}

function uniqueTextList(values = []) {
  const out = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeWarehouseName(value) {
  return String(value || "").trim().toLowerCase();
}

function getRequestedWarehouseName(options = {}) {
  return String(options?.warehouseName || options?.storeName || SKLAD_FBS_WAREHOUSE_NAME || "").trim();
}

function getRequestedWarehouseId(options = {}) {
  const value = Number(options?.warehouseId ?? SKLAD_FBS_WAREHOUSE_ID ?? 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isLikelyBarcodeValue(value) {
  const normalized = normalizeBarcode(value).toUpperCase();
  if (!normalized) return false;
  if (/^\d{6,}$/.test(normalized)) return true;
  if (/^(OZN|MRKT|WB)[A-Z0-9-]{4,}$/.test(normalized)) return true;
  return false;
}

function extractMarketplaceEntries(product) {
  return Array.isArray(product?.marketplace_barcodes_json) ? product.marketplace_barcodes_json : [];
}

function extractMarketplaceBarcodes(product, type = null) {
  const normalizedType = String(type || "").trim().toLowerCase();
  const out = [];
  for (const entry of extractMarketplaceEntries(product)) {
    const entryType = String(entry?.type || "").trim().toLowerCase();
    if (normalizedType && entryType !== normalizedType) continue;
    const value = normalizeBarcode(entry?.value);
    if (value && isLikelyBarcodeValue(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

function extractAllProductBarcodes(product) {
  return uniqueTextList([
    ...String(product?.barcode_list || "")
      .split(";")
      .map((value) => normalizeBarcode(value))
      .filter((value) => isLikelyBarcodeValue(value)),
    normalizeBarcode(product?.production_barcode),
    ...extractMarketplaceBarcodes(product),
  ].filter((value) => isLikelyBarcodeValue(value)));
}

export function extractMsBarcodes(product) {
  return extractAllProductBarcodes(product);
}

function normalizeLookupToken(value) {
  return String(value || "").replace(/\s+/g, "").trim().toUpperCase();
}

// Exact bundle composition from the warehouse DB. Every known bundle identifier
// (article/code/marketplace barcode) points to the same resolved definition.
export async function getMsBundleComponents(tokens) {
  const keys = Array.from(
    new Set((Array.isArray(tokens) ? tokens : []).map(normalizeLookupToken).filter(Boolean))
  );
  const result = new Map();
  if (!keys.length) return result;

  const rows = await skladQuery(
    `select b.id as bundle_id,
            b.article as bundle_article,
            b.code as bundle_code,
            b.name as bundle_name,
            b.production_barcode as bundle_production_barcode,
            b.barcode_list as bundle_barcode_list,
            b.marketplace_barcodes_json as bundle_marketplace_barcodes_json,
            c.id as component_id,
            c.article as component_article,
            c.code as component_code,
            c.name as component_name,
            c.entity_type as component_entity_type,
            c.production_barcode,
            c.barcode_list,
            c.marketplace_barcodes_json,
            bc.quantity
       from products_s b
       left join bundle_components_s bc on bc.bundle_id = b.id
       left join products_s c on c.id = bc.component_id and coalesce(c.archived, false) = false
      where lower(coalesce(b.entity_type, '')) = 'bundle'
        and (
          upper(btrim(coalesce(b.article, ''))) = any($1::text[])
          or upper(btrim(coalesce(b.code, ''))) = any($1::text[])
          or upper(regexp_replace(coalesce(b.production_barcode, ''), '\\s+', '', 'g')) = any($1::text[])
          or exists (
            select 1 from regexp_split_to_table(coalesce(b.barcode_list, ''), ';') raw(value)
            where upper(regexp_replace(btrim(raw.value), '\\s+', '', 'g')) = any($1::text[])
          )
          or exists (
            select 1 from jsonb_array_elements(
              case when jsonb_typeof(coalesce(b.marketplace_barcodes_json, '[]'::jsonb)) = 'array'
                   then coalesce(b.marketplace_barcodes_json, '[]'::jsonb) else '[]'::jsonb end
            ) entry
            where upper(regexp_replace(coalesce(entry->>'value', ''), '\\s+', '', 'g')) = any($1::text[])
          )
        )
      order by coalesce(b.archived, false), b.id, c.id`,
    [keys]
  );

  const bundles = new Map();
  for (const row of rows.rows || []) {
    const bundleId = Number(row.bundle_id);
    if (!bundles.has(bundleId)) {
      bundles.set(bundleId, {
        id: bundleId,
        article: row.bundle_article || row.bundle_code || null,
        name: row.bundle_name || null,
        identifiers: uniqueTextList([
          row.bundle_article,
          row.bundle_code,
          row.bundle_production_barcode,
          ...String(row.bundle_barcode_list || "").split(";"),
          ...extractMarketplaceBarcodes({ marketplace_barcodes_json: row.bundle_marketplace_barcodes_json }),
        ]).map(normalizeLookupToken).filter(Boolean),
        components: [],
      });
    }
    if (row.component_id == null) continue;
    const product = {
      production_barcode: row.production_barcode,
      barcode_list: row.barcode_list,
      marketplace_barcodes_json: row.marketplace_barcodes_json,
    };
    const barcodes = extractAllProductBarcodes(product).map(normalizeBarcode).filter(Boolean);
    bundles.get(bundleId).components.push({
      id: Number(row.component_id),
      article: row.component_article || row.component_code || null,
      name: row.component_name || null,
      entityType: String(row.component_entity_type || "").trim().toLowerCase() || null,
      quantity: Math.max(1, Number(row.quantity || 1)),
      barcode: normalizeBarcode(row.production_barcode) || barcodes[0] || null,
      barcodes,
    });
  }

  const keySet = new Set(keys);
  for (const bundle of bundles.values()) {
    if (!bundle.components.length) continue;
    for (const identifier of bundle.identifiers) {
      if (keySet.has(identifier) && !result.has(identifier)) result.set(identifier, bundle);
    }
  }
  return result;
}

function buildMatch(product, options = {}) {
  return {
    id: product?.id ?? null,
    article: product?.article || product?.code || null,
    name: product?.name || null,
    barcodes: extractAllProductBarcodes(product),
    marketplaceBarcode: extractMarketplaceBarcodes(product, options?.marketplaceType)[0] || "",
  };
}

function getEquivalentProductSignature(product) {
  return JSON.stringify({
    article: normalizeArticleKey(product?.article || product?.code),
    code: normalizeArticleKey(product?.code || product?.article),
    name: String(product?.name || "").trim().toLowerCase(),
    barcodes: extractAllProductBarcodes(product)
      .map((value) => normalizeBarcode(value))
      .filter(Boolean)
      .sort(),
  });
}

function buildUniqueMatches(products = [], options = {}) {
  const seen = new Set();
  const out = [];
  for (const product of products) {
    const signature = getEquivalentProductSignature(product);
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(buildMatch(product, options));
  }
  return out;
}

function canMergeEquivalentProducts(products = []) {
  if (!Array.isArray(products) || products.length <= 1) return false;
  return uniqueTextList(products.map((product) => getEquivalentProductSignature(product))).length === 1;
}

function filterProductsByArticle(products = [], article) {
  const target = normalizeArticleKey(article);
  if (!target) return products;
  const matches = products.filter((product) => {
    const articleKey = normalizeArticleKey(product?.article);
    const codeKey = normalizeArticleKey(product?.code);
    return articleKey === target || codeKey === target;
  });
  return matches.length ? matches : products;
}

function wrapSkladError(error, message) {
  const wrapped = new Error(message || error?.message || "Складская БД недоступна");
  wrapped.cause = error;
  wrapped.isMsApiAccessError = true;
  wrapped.isSkladDbAccessError = true;
  return wrapped;
}

export function isMsApiAccessError(error) {
  return Boolean(error?.isMsApiAccessError || error?.isSkladDbAccessError);
}

export function wrapMsApiAccessError(error, message) {
  return wrapSkladError(error, message);
}

function makePool(useSsl) {
  return new Pool({
    host: SKLAD_DB_HOST,
    port: SKLAD_DB_PORT,
    user: SKLAD_DB_USER,
    password: SKLAD_DB_PASSWORD,
    database: SKLAD_DB_NAME,
    application_name: "sborka-sklad-ms",
    max: SKLAD_DB_POOL_MAX,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
}

function isRetryablePgConnectionError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  return (
    code === "ECONNRESET" ||
    code === "53300" ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    message.includes("remaining connection slots are reserved") ||
    message.includes("too many clients already") ||
    message.includes("timeout exceeded when trying to connect") ||
    message.includes("connection terminated unexpectedly") ||
    message.includes("terminating connection") ||
    message.includes("server closed the connection unexpectedly") ||
    message.includes("read econnreset") ||
    message.includes("socket hang up")
  );
}

async function resetPool(currentPool = null) {
  const existingPromise = poolPromise;
  poolPromise = null;
  if (currentPool) {
    try {
      await currentPool.end();
    } catch {}
    return;
  }
  if (!existingPromise) return;
  try {
    const existingPool = await existingPromise;
    if (existingPool) {
      await existingPool.end();
    }
  } catch {}
}

async function createAndTestPool(useSsl) {
  const pool = makePool(useSsl);
  try {
    await pool.query("select 1 as ok");
    return pool;
  } catch (error) {
    try {
      await pool.end();
    } catch {}
    throw error;
  }
}

async function getPool() {
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    if (SKLAD_DB_SSL === "disable") return createAndTestPool(false);
    if (SKLAD_DB_SSL === "require") return createAndTestPool(true);
    try {
      return await createAndTestPool(true);
    } catch {
      return createAndTestPool(false);
    }
  })();
  return poolPromise;
}

async function skladQuery(text, params = []) {
  let pool = await getPool();
  try {
    return await pool.query(text, params);
  } catch (error) {
    if (!isRetryablePgConnectionError(error) || String(error?.code || "").trim().toUpperCase() === "53300") {
      throw error;
    }
    await resetPool(pool);
    pool = await getPool();
    return pool.query(text, params);
  }
}

async function getWarehouse(warehouseName, options = {}) {
  const warehouseId = getRequestedWarehouseId(options);
  const normalized = normalizeWarehouseName(warehouseName);
  const cacheKey = warehouseId
    ? getCacheKey("warehouse_id", warehouseId)
    : normalized
      ? getCacheKey("warehouse", normalized)
      : null;
  if (!cacheKey) return null;
  const cached = getCachedValue(warehouseCache, cacheKey, options?.force === true);
  if (cached) return cached;
  const result = warehouseId
    ? await skladQuery(
        `select id, name
         from warehouses_s
         where active is true
           and id = $1
         limit 1`,
        [warehouseId]
      )
    : await skladQuery(
        `select id, name
         from warehouses_s
         where active is true
           and lower(btrim(name)) = lower(btrim($1))
         order by id
         limit 1`,
        [warehouseName]
      );
  return rememberValue(warehouseCache, cacheKey, result.rows?.[0] || null);
}

async function findProductsByBarcode(barcode) {
  const normalizedBarcode = normalizeBarcode(barcode);
  if (!normalizedBarcode || !isLikelyBarcodeValue(normalizedBarcode)) return [];
  const result = await skladQuery(
    `select distinct p.*
     from products_s p
     where coalesce(p.archived, false) = false
       and (
         regexp_replace(coalesce(p.production_barcode, ''), '\s+', '', 'g') = $1
         or exists (
           select 1
           from regexp_split_to_table(coalesce(p.barcode_list, ''), ';') as raw_barcode(value)
           where regexp_replace(btrim(raw_barcode.value), '\s+', '', 'g') = $1
         )
         or exists (
           select 1
           from jsonb_array_elements(
             case
               when jsonb_typeof(coalesce(p.marketplace_barcodes_json, '[]'::jsonb)) = 'array'
                 then coalesce(p.marketplace_barcodes_json, '[]'::jsonb)
               else '[]'::jsonb
             end
           ) as entry
           where regexp_replace(coalesce(entry->>'value', ''), '\s+', '', 'g') = $1
         )
       )
     order by p.id`,
    [normalizedBarcode]
  );
  return result.rows || [];
}

async function findProductsByBarcodes(barcodes = []) {
  const normalizedBarcodes = uniqueTextList(
    (Array.isArray(barcodes) ? barcodes : [])
      .map((value) => normalizeBarcode(value))
      .filter((value) => value && isLikelyBarcodeValue(value))
  );
  if (!normalizedBarcodes.length) return [];
  const result = await skladQuery(
    `select distinct p.*
     from products_s p
     where coalesce(p.archived, false) = false
       and (
         regexp_replace(coalesce(p.production_barcode, ''), '\s+', '', 'g') = any($1::text[])
         or exists (
           select 1
           from regexp_split_to_table(coalesce(p.barcode_list, ''), ';') as raw_barcode(value)
           where regexp_replace(btrim(raw_barcode.value), '\s+', '', 'g') = any($1::text[])
         )
         or exists (
           select 1
           from jsonb_array_elements(
             case
               when jsonb_typeof(coalesce(p.marketplace_barcodes_json, '[]'::jsonb)) = 'array'
                 then coalesce(p.marketplace_barcodes_json, '[]'::jsonb)
               else '[]'::jsonb
             end
           ) as entry
           where regexp_replace(coalesce(entry->>'value', ''), '\s+', '', 'g') = any($1::text[])
         )
       )
     order by p.id`,
    [normalizedBarcodes]
  );
  return result.rows || [];
}

async function findProductsByArticle(article) {
  const normalizedArticle = normalizeArticleKey(article);
  if (!normalizedArticle) return [];
  const result = await skladQuery(
    `select p.*
     from products_s p
     where coalesce(p.archived, false) = false
       and (
         upper(btrim(coalesce(p.article, ''))) = upper(btrim($1))
         or upper(btrim(coalesce(p.code, ''))) = upper(btrim($1))
       )
     order by p.id`,
    [normalizedArticle]
  );
  return result.rows || [];
}

async function getProductStocks(productIds, warehouseId) {
  if (!Array.isArray(productIds) || productIds.length === 0) return new Map();
  const result = await skladQuery(
    `select p.id,
            coalesce(stock_data.location_stock, 0)::numeric as shelf_stock,
            coalesce(stock_data.slots, '[]'::json) as slots
     from products_s p
     left join lateral (
       select coalesce(sum(location_rows.location_qty), 0)::numeric as location_stock,
              coalesce(
                json_agg(
                  json_build_object(
                    'id', location_rows.location_id,
                    'name', location_rows.location_name,
                    'stock', location_rows.location_qty
                  )
                  order by location_rows.location_qty desc, location_rows.location_sort_name
                ) filter (where location_rows.location_id is not null),
                '[]'::json
              ) as slots
       from (
         select concat('shelf_box:', sb.id)::text as location_id,
                coalesce(
                  nullif(btrim(sb.name), ''),
                  concat(
                    coalesce(nullif(btrim(s.code), ''), nullif(btrim(s.name), ''), s.id::text),
                    'К',
                    coalesce(nullif(sb.position::text, ''), sb.id::text)
                  )
                ) as location_name,
                coalesce(
                  nullif(btrim(sb.name), ''),
                  concat(
                    coalesce(nullif(btrim(s.code), ''), nullif(btrim(s.name), ''), s.id::text),
                    'К',
                    coalesce(nullif(sb.position::text, ''), sb.id::text)
                  )
                ) as location_sort_name,
                sum(sb.quantity)::numeric as location_qty
         from shelf_boxes_s sb
         join shelves_s s on s.id = sb.shelf_id
         join racks_s r on r.id = s.rack_id
         where sb.product_id = p.id
           and r.warehouse_id = $2
         group by sb.id, location_name, location_sort_name

         union all

         select concat('shelf:', s.id)::text as location_id,
                coalesce(nullif(btrim(s.code), ''), nullif(btrim(s.name), ''), s.id::text) as location_name,
                coalesce(nullif(btrim(s.code), ''), nullif(btrim(s.name), ''), s.id::text) as location_sort_name,
                sum(si.quantity)::numeric as location_qty
         from shelf_items_s si
         join shelves_s s on s.id = si.shelf_id
         join racks_s r on r.id = s.rack_id
         where si.product_id = p.id
           and r.warehouse_id = $2
           and si.quantity > 0
           and (
             coalesce(s.uses_boxes, false) = false
             or not exists (
               select 1
               from shelf_boxes_s sbx
               where sbx.shelf_id = s.id
                 and sbx.product_id = si.product_id
                 and coalesce(sbx.quantity, 0) > 0
             )
           )
         group by s.id, location_name, location_sort_name
       ) as location_rows
     ) as stock_data on true
     where p.id = any($1::int[])`,
    [productIds, warehouseId]
  );
  const map = new Map();
  for (const row of result.rows || []) {
    const slots = Array.isArray(row?.slots)
      ? row.slots
          .map((entry) => ({
            id: entry?.id ?? null,
            name: String(entry?.name || entry?.id || "").trim() || null,
            stock: Number(entry?.stock || 0),
          }))
          .filter((entry) => entry.name || entry.stock > 0)
      : [];
    map.set(Number(row.id), {
      stock: Number(toFiniteNumber(row?.shelf_stock) ?? 0),
      slots,
    });
  }
  return map;
}

function mergeStockEntries(entries = []) {
  const slotMap = new Map();
  let stock = 0;
  for (const entry of entries) {
    const entryStock = Number(entry?.stock || 0);
    if (entryStock > 0) stock += entryStock;
    for (const slot of Array.isArray(entry?.slots) ? entry.slots : []) {
      const key = `${slot?.id ?? ""}|${String(slot?.name || "").trim()}`;
      if (!slotMap.has(key)) {
        slotMap.set(key, {
          id: slot?.id ?? null,
          name: String(slot?.name || slot?.id || "").trim() || null,
          stock: 0,
        });
      }
      const current = slotMap.get(key);
      current.stock += Number(slot?.stock || 0);
    }
  }
  const slots = Array.from(slotMap.values())
    .filter((entry) => entry.name || entry.stock > 0)
    .sort((a, b) => {
      if (b.stock !== a.stock) return b.stock - a.stock;
      return String(a.name || "").localeCompare(String(b.name || ""), "ru-RU");
    });
  return { stock, slots };
}

function buildLookupPayload(products = [], options = {}) {
  const matches = buildUniqueMatches(products, options);
  const barcodes = uniqueTextList(matches.flatMap((match) => match?.barcodes || []));
  const multiple = matches.length > 1 && !canMergeEquivalentProducts(products);
  return {
    found: matches.length > 0,
    multiple,
    matches,
    barcodes,
  };
}

async function fetchProductByArticle(article, options = {}) {
  const normalizedArticle = normalizeArticleKey(article);
  if (!normalizedArticle) {
    return { article: "", found: false, multiple: false, matches: [], barcodes: [] };
  }
  const cacheKey = getCacheKey("lookup_article", normalizedArticle);
  const cached = getCachedValue(lookupCache, cacheKey, options?.force === true);
  if (cached) return cached;
  const products = await findProductsByArticle(normalizedArticle);
  return rememberValue(lookupCache, cacheKey, {
    article: normalizedArticle,
    ...buildLookupPayload(products, options),
  });
}

async function fetchProductByBarcode(barcode, options = {}) {
  const normalizedBarcode = normalizeBarcode(barcode);
  if (!normalizedBarcode) {
    return { barcode: "", found: false, multiple: false, matches: [], barcodes: [] };
  }
  const normalizedArticle = normalizeArticleKey(options?.fallbackArticle);
  const cacheKey = getCacheKey("lookup_barcode", `${normalizedBarcode}|${normalizedArticle || ""}`);
  const cached = getCachedValue(lookupCache, cacheKey, options?.force === true);
  if (cached) return cached;
  let products = await findProductsByBarcode(normalizedBarcode);
  if ((!products || products.length === 0) && normalizedArticle) {
    products = await findProductsByArticle(normalizedArticle);
  } else if (products.length > 1 && normalizedArticle) {
    products = filterProductsByArticle(products, normalizedArticle);
  }
  return rememberValue(lookupCache, cacheKey, {
    barcode: normalizedBarcode,
    article: normalizedArticle || null,
    ...buildLookupPayload(products, options),
  });
}

async function resolveSingleProductStatus(products, basePayload, options = {}) {
  const warehouseName = getRequestedWarehouseName(options);
  const warehouse = await getWarehouse(warehouseName, options);
  if (!warehouse) {
    return {
      ...basePayload,
      status: "store_not_found",
      found: true,
      multiple: false,
      stock: null,
      slots: [],
      storeName: warehouseName,
      error: `Склад "${warehouseName}" не найден в складской БД`,
    };
  }

  const [product] = products;
  const stockMap = await getProductStocks([Number(product.id)], Number(warehouse.id));
  const stockEntry = stockMap.get(Number(product.id)) || { stock: 0, slots: [] };
  return {
    ...basePayload,
    status: "ok",
    found: true,
    multiple: false,
    stock: Number(stockEntry.stock || 0),
    slots: stockEntry.slots || [],
    storeName: warehouse.name || warehouseName,
    error: null,
  };
}

async function resolveEquivalentProductsStatus(products, basePayload, options = {}) {
  const warehouseName = getRequestedWarehouseName(options);
  const warehouse = await getWarehouse(warehouseName, options);
  if (!warehouse) {
    return {
      ...basePayload,
      status: "store_not_found",
      found: true,
      multiple: false,
      stock: null,
      slots: [],
      storeName: warehouseName,
      error: `Склад "${warehouseName}" не найден в складской БД`,
    };
  }

  const productIds = products
    .map((product) => Number(product?.id))
    .filter((value) => Number.isInteger(value) && value > 0);
  const stockMap = await getProductStocks(productIds, Number(warehouse.id));
  const merged = mergeStockEntries(productIds.map((productId) => stockMap.get(productId) || { stock: 0, slots: [] }));
  return {
    ...basePayload,
    status: "ok",
    found: true,
    multiple: false,
    stock: Number(merged.stock || 0),
    slots: merged.slots || [],
    storeName: warehouse.name || warehouseName,
    error: null,
  };
}

export async function msRequest() {
  throw wrapSkladError(new Error("Внешний складской API отключен. Используется складская БД."));
}

export async function assertMsApiAvailable(warehouseName = SKLAD_FBS_WAREHOUSE_NAME, options = {}) {
  try {
    await skladQuery("select 1 as ok");
    const warehouse = await getWarehouse(warehouseName, options);
    if (!warehouse) {
      throw new Error(`Склад "${warehouseName}" не найден в складской БД`);
    }
    return true;
  } catch (error) {
    throw wrapSkladError(error);
  }
}

export async function getMsBarcodesByArticle(article, options = {}) {
  const result = await fetchProductByArticle(article, options);
  return result.barcodes || [];
}

export async function getMsProductStatusByArticle(article, options = {}) {
  const result = await fetchProductByArticle(article, options);
  return {
    found: Boolean(result.found),
    multiple: Boolean(result.multiple),
    barcodes: result.barcodes || [],
    matches: Array.isArray(result.matches) ? result.matches : [],
  };
}

export async function getMsBarcodesByBarcode(barcode, options = {}) {
  const result = await fetchProductByBarcode(barcode, options);
  return result.barcodes || [];
}

export async function getMsProductStatusByBarcode(barcode, options = {}) {
  const result = await fetchProductByBarcode(barcode, options);
  return {
    found: Boolean(result.found),
    multiple: Boolean(result.multiple),
    barcodes: result.barcodes || [],
    matches: Array.isArray(result.matches) ? result.matches : [],
  };
}

export async function getMsStockStatusByBarcode(barcode, options = {}) {
  const normalizedBarcode = normalizeBarcode(barcode);
  const normalizedArticle = normalizeArticleKey(options?.fallbackArticle);
  const warehouseName = getRequestedWarehouseName(options);
  if (!normalizedBarcode) {
    return {
      status: "invalid",
      barcode: "",
      article: normalizedArticle,
      found: false,
      multiple: false,
      matches: [],
      stock: null,
      slots: [],
      storeName: warehouseName,
      error: "Пустой баркод",
    };
  }

  const cacheKey = getCacheKey(
    "stock_by_barcode",
    `${normalizeWarehouseName(warehouseName)}|${normalizedBarcode}|${normalizedArticle || ""}`
  );
  const cached = getCachedValue(stockCache, cacheKey, options?.force === true);
  if (cached) return cached;

  try {
    let products = await findProductsByBarcode(normalizedBarcode);
    if ((!products || products.length === 0) && normalizedArticle) {
      products = await findProductsByArticle(normalizedArticle);
    } else if (products.length > 1 && normalizedArticle) {
      products = filterProductsByArticle(products, normalizedArticle);
    }

    const matches = buildUniqueMatches(products, options);
    if (!products.length) {
      return rememberValue(stockCache, cacheKey, {
        status: "not_found",
        barcode: normalizedBarcode,
        article: normalizedArticle,
        found: false,
        multiple: false,
        matches: [],
        stock: null,
        slots: [],
        storeName: warehouseName,
        error: normalizedArticle
          ? "Товар не найден в складской БД ни по баркоду, ни по артикулу"
          : "Товар по баркоду не найден в складской БД",
      });
    }

    if (products.length > 1 && canMergeEquivalentProducts(products)) {
      return rememberValue(
        stockCache,
        cacheKey,
        await resolveEquivalentProductsStatus(
          products,
          {
            barcode: normalizedBarcode,
            article: normalizedArticle || matches[0]?.article || null,
            matches,
          },
          options
        )
      );
    }

    if (products.length > 1) {
      return rememberValue(stockCache, cacheKey, {
        status: "multiple",
        barcode: normalizedBarcode,
        article: normalizedArticle,
        found: true,
        multiple: true,
        matches,
        stock: null,
        slots: [],
        storeName: warehouseName,
        error: "По баркоду найдено несколько товаров в складской БД",
      });
    }

    return rememberValue(
      stockCache,
      cacheKey,
      await resolveSingleProductStatus(
        products,
        {
          barcode: normalizedBarcode,
          article: normalizedArticle || matches[0]?.article || null,
          matches,
        },
        options
      )
    );
  } catch (error) {
    return {
      status: "error",
      barcode: normalizedBarcode,
      article: normalizedArticle,
      found: false,
      multiple: false,
      matches: [],
      stock: null,
      slots: [],
      storeName: warehouseName,
      error: error?.message || "Ошибка чтения складской БД",
    };
  }
}

export async function getMsStockStatusesByBarcodes(requests = [], options = {}) {
  const warehouseName = getRequestedWarehouseName(options);
  const requestList = Array.isArray(requests) ? requests : [];
  const resultMap = new Map();
  const pending = [];

  for (const entry of requestList) {
    const key = String(entry?.key || normalizeBarcode(entry?.barcode) || "").trim();
    const barcode = normalizeBarcode(entry?.barcode);
    const article = normalizeArticleKey(entry?.fallbackArticle);
    if (!key) continue;
    if (!barcode) {
      resultMap.set(key, {
        status: "invalid",
        barcode: "",
        article,
        found: false,
        multiple: false,
        matches: [],
        stock: null,
        slots: [],
        storeName: warehouseName,
        error: "Пустой баркод",
      });
      continue;
    }
    const cacheKey = getCacheKey(
      "stock_by_barcode",
      `${normalizeWarehouseName(warehouseName)}|${barcode}|${article || ""}`
    );
    const cached = getCachedValue(stockCache, cacheKey, options?.force === true);
    if (cached) {
      resultMap.set(key, cached);
      continue;
    }
    pending.push({ key, barcode, article, cacheKey });
  }

  if (!pending.length) return resultMap;

  try {
    const products = await findProductsByBarcodes(pending.map((entry) => entry.barcode));
    const productBarcodesCache = new Map();
    const requestProducts = new Map();

    const getProductBarcodes = (product) => {
      const productId = Number(product?.id || 0);
      if (productId > 0 && productBarcodesCache.has(productId)) {
        return productBarcodesCache.get(productId);
      }
      const barcodes = extractAllProductBarcodes(product);
      if (productId > 0) {
        productBarcodesCache.set(productId, barcodes);
      }
      return barcodes;
    };

    for (const entry of pending) {
      let matchedProducts = products.filter((product) => getProductBarcodes(product).includes(entry.barcode));
      if ((!matchedProducts || matchedProducts.length === 0) && entry.article) {
        matchedProducts = await findProductsByArticle(entry.article);
      } else if (matchedProducts.length > 1 && entry.article) {
        matchedProducts = filterProductsByArticle(matchedProducts, entry.article);
      }
      requestProducts.set(entry.key, matchedProducts || []);
    }

    const warehouse = await getWarehouse(warehouseName, options);
    if (!warehouse) {
      for (const entry of pending) {
        const status = rememberValue(stockCache, entry.cacheKey, {
          status: "store_not_found",
          barcode: entry.barcode,
          article: entry.article,
          found: true,
          multiple: false,
          matches: [],
          stock: null,
          slots: [],
          storeName: warehouseName,
          error: `Склад "${warehouseName}" не найден в складской БД`,
        });
        resultMap.set(entry.key, status);
      }
      return resultMap;
    }

    const productIds = Array.from(
      new Set(
        pending.flatMap((entry) =>
          (requestProducts.get(entry.key) || [])
            .map((product) => Number(product?.id))
            .filter((value) => Number.isInteger(value) && value > 0)
        )
      )
    );
    const stockMap = await getProductStocks(productIds, Number(warehouse.id));

    for (const entry of pending) {
      const matchedProducts = requestProducts.get(entry.key) || [];
      const matches = buildUniqueMatches(matchedProducts, options);
      let status;
      if (!matchedProducts.length) {
        status = {
          status: "not_found",
          barcode: entry.barcode,
          article: entry.article,
          found: false,
          multiple: false,
          matches: [],
          stock: null,
          slots: [],
          storeName: warehouseName,
          error: entry.article
            ? "Товар не найден в складской БД ни по баркоду, ни по артикулу"
            : "Товар по баркоду не найден в складской БД",
        };
      } else if (matchedProducts.length > 1 && canMergeEquivalentProducts(matchedProducts)) {
        const merged = mergeStockEntries(
          matchedProducts.map((product) => stockMap.get(Number(product.id)) || { stock: 0, slots: [] })
        );
        status = {
          status: "ok",
          barcode: entry.barcode,
          article: entry.article || matches[0]?.article || null,
          found: true,
          multiple: false,
          matches,
          stock: Number(merged.stock || 0),
          slots: merged.slots || [],
          storeName: warehouse.name || warehouseName,
          error: null,
        };
      } else if (matchedProducts.length > 1) {
        status = {
          status: "multiple",
          barcode: entry.barcode,
          article: entry.article,
          found: true,
          multiple: true,
          matches,
          stock: null,
          slots: [],
          storeName: warehouse.name || warehouseName,
          error: "По баркоду найдено несколько товаров в складской БД",
        };
      } else {
        const product = matchedProducts[0];
        const stockEntry = stockMap.get(Number(product?.id)) || { stock: 0, slots: [] };
        status = {
          status: "ok",
          barcode: entry.barcode,
          article: entry.article || matches[0]?.article || null,
          found: true,
          multiple: false,
          matches,
          stock: Number(stockEntry.stock || 0),
          slots: stockEntry.slots || [],
          storeName: warehouse.name || warehouseName,
          error: null,
        };
      }
      resultMap.set(entry.key, rememberValue(stockCache, entry.cacheKey, status));
    }

    return resultMap;
  } catch (error) {
    for (const entry of pending) {
      resultMap.set(entry.key, {
        status: "error",
        barcode: entry.barcode,
        article: entry.article,
        found: false,
        multiple: false,
        matches: [],
        stock: null,
        slots: [],
        storeName: warehouseName,
        error: error?.message || "Ошибка чтения складской БД",
      });
    }
    return resultMap;
  }
}

export async function getMsStockStatusByArticle(article, options = {}) {
  const normalizedArticle = normalizeArticleKey(article);
  const warehouseName = getRequestedWarehouseName(options);
  const marketplaceType = String(options?.marketplaceType || "").trim().toLowerCase() || null;
  if (!normalizedArticle) {
    return {
      status: "invalid",
      article: "",
      found: false,
      multiple: false,
      matches: [],
      stock: null,
      slots: [],
      storeName: warehouseName,
      marketplaceBarcode: "",
      error: "Пустой артикул",
    };
  }

  const cacheKey = getCacheKey(
    "stock_by_article",
    `${normalizeWarehouseName(warehouseName)}|${normalizedArticle}|${marketplaceType || ""}`
  );
  const cached = getCachedValue(stockCache, cacheKey, options?.force === true);
  if (cached) return cached;

  try {
    const products = await findProductsByArticle(normalizedArticle);
    const matches = buildUniqueMatches(products, options);
    if (!products.length) {
      return rememberValue(stockCache, cacheKey, {
        status: "not_found",
        article: normalizedArticle,
        found: false,
        multiple: false,
        matches: [],
        stock: null,
        slots: [],
        storeName: warehouseName,
        marketplaceBarcode: "",
        error: "Товар по артикулу не найден в складской БД",
      });
    }

    if (products.length > 1 && canMergeEquivalentProducts(products)) {
      const merged = await resolveEquivalentProductsStatus(
        products,
        {
          article: normalizedArticle,
          matches,
          marketplaceBarcode: matches[0]?.marketplaceBarcode || "",
        },
        options
      );
      return rememberValue(stockCache, cacheKey, {
        ...merged,
        marketplaceBarcode: matches[0]?.marketplaceBarcode || "",
      });
    }

    if (products.length > 1) {
      return rememberValue(stockCache, cacheKey, {
        status: "multiple",
        article: normalizedArticle,
        found: true,
        multiple: true,
        matches,
        stock: null,
        slots: [],
        storeName: warehouseName,
        marketplaceBarcode: matches[0]?.marketplaceBarcode || "",
        error: "По артикулу найдено несколько товаров в складской БД",
      });
    }

    const status = await resolveSingleProductStatus(
      products,
      {
        article: normalizedArticle,
        matches,
        marketplaceBarcode: matches[0]?.marketplaceBarcode || "",
      },
      options
    );
    return rememberValue(stockCache, cacheKey, {
      ...status,
      marketplaceBarcode: matches[0]?.marketplaceBarcode || "",
    });
  } catch (error) {
    return {
      status: "error",
      article: normalizedArticle,
      found: false,
      multiple: false,
      matches: [],
      stock: null,
      slots: [],
      storeName: warehouseName,
      marketplaceBarcode: "",
      error: error?.message || "Ошибка чтения складской БД",
    };
  }
}
