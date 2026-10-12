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

const statusCache = new Map();
const warehouseCache = new Map();
let poolPromise = null;

export function clearSkladFbsCaches() {
  statusCache.clear();
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
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function extractAllProductBarcodes(product) {
  return uniqueTextList([
    ...String(product?.barcode_list || "")
      .split(";")
      .map((value) => normalizeBarcode(value))
      .filter(Boolean),
    normalizeBarcode(product?.production_barcode),
    ...extractMarketplaceBarcodes(product),
  ]);
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

function getEquivalentProductSignature(product, options = {}) {
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
    const signature = getEquivalentProductSignature(product, options);
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(buildMatch(product, options));
  }
  return out;
}

function canMergeEquivalentProducts(products = [], options = {}) {
  if (!Array.isArray(products) || products.length <= 1) return false;
  return uniqueTextList(products.map((product) => getEquivalentProductSignature(product, options))).length === 1;
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

function wrapSkladDbAccessError(error, message) {
  const wrapped = new Error(message || error?.message || "Складская БД недоступна");
  wrapped.cause = error;
  wrapped.isSkladDbAccessError = true;
  return wrapped;
}

export function isSkladDbAccessError(error) {
  return Boolean(error?.isSkladDbAccessError);
}

function makePool(useSsl) {
  return new Pool({
    host: SKLAD_DB_HOST,
    port: SKLAD_DB_PORT,
    user: SKLAD_DB_USER,
    password: SKLAD_DB_PASSWORD,
    database: SKLAD_DB_NAME,
    application_name: "sborka-sklad-fbs",
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
  if (!normalizedBarcode) return [];
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
            coalesce(stock_data.slots, '[]'::json) as slots,
            (exists (
               select 1 from shelf_boxes_s sbp
               join shelves_s sp on sp.id = sbp.shelf_id
               join racks_s rp on rp.id = sp.rack_id
               where sbp.product_id = p.id and rp.warehouse_id = $2
             ) or exists (
               select 1 from shelf_items_s sip
               join shelves_s sp2 on sp2.id = sip.shelf_id
               join racks_s rp2 on rp2.id = sp2.rack_id
               where sip.product_id = p.id and rp2.warehouse_id = $2
             )) as placed
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
    const shelfStock = Number(toFiniteNumber(row?.shelf_stock) ?? 0);
    map.set(Number(row.id), {
      stock: shelfStock,
      slots,
      placed: row?.placed === true, // есть назначение ячейки в этом складе (даже при остатке 0)
    });
  }
  return map;
}

function mergeStockEntries(entries = []) {
  const slotMap = new Map();
  let stock = 0;
  let placed = false;
  for (const entry of entries) {
    if (entry?.placed === true) placed = true;
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
  return {
    stock,
    slots,
    placed,
  };
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
  const stockEntry = stockMap.get(Number(product.id)) || { stock: 0, slots: [], placed: false };
  return {
    ...basePayload,
    status: "ok",
    found: true,
    multiple: false,
    stock: Number(stockEntry.stock || 0),
    slots: stockEntry.slots || [],
    placed: stockEntry.placed === true,
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
  const merged = mergeStockEntries(productIds.map((productId) => stockMap.get(productId) || { stock: 0, slots: [], placed: false }));
  return {
    ...basePayload,
    status: "ok",
    found: true,
    multiple: false,
    stock: Number(merged.stock || 0),
    slots: merged.slots || [],
    placed: merged.placed === true,
    storeName: warehouse.name || warehouseName,
    error: null,
  };
}

export async function assertSkladDbAvailable(warehouseName, options = {}) {
  try {
    await skladQuery("select 1 as ok");
    const warehouse = await getWarehouse(warehouseName, options);
    if (!warehouse) {
      throw new Error(`Склад "${warehouseName}" не найден в складской БД`);
    }
    return true;
  } catch (error) {
    throw wrapSkladDbAccessError(error, error?.message || "Складская БД недоступна");
  }
}

export async function getSkladFbsStockStatusByBarcode(barcode, options = {}) {
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
  const cached = getCachedValue(statusCache, cacheKey, options?.force === true);
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
      return rememberValue(statusCache, cacheKey, {
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

    if (products.length > 1 && canMergeEquivalentProducts(products, options)) {
      return rememberValue(
        statusCache,
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
      return rememberValue(statusCache, cacheKey, {
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
      statusCache,
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

export async function getSkladFbsStockStatusByArticle(article, options = {}) {
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
  const cached = getCachedValue(statusCache, cacheKey, options?.force === true);
  if (cached) return cached;

  try {
    const products = await findProductsByArticle(normalizedArticle);
    const matches = products.map((product) => buildMatch(product, options));
    if (!products.length) {
      return rememberValue(statusCache, cacheKey, {
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

    if (products.length > 1) {
      return rememberValue(statusCache, cacheKey, {
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
    return rememberValue(statusCache, cacheKey, {
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

// Raw access to the sklad (GRAsklad) DB for callers that need custom queries
// (e.g. per-warehouse stock for the exclude-articles picker).
export async function skladRawQuery(text, params = []) {
  return skladQuery(text, params);
}
