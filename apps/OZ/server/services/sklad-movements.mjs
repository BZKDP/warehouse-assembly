import { Pool } from "pg";
import {
  SKLAD_DB_HOST,
  SKLAD_DB_NAME,
  SKLAD_DB_PASSWORD,
  SKLAD_DB_POOL_MAX,
  SKLAD_DB_PORT,
  SKLAD_DB_SSL,
  SKLAD_DB_USER,
  DB_POOL_CONNECTION_TIMEOUT_MS,
  SKLAD_FBS_WAREHOUSE_ID,
} from "../config.mjs";
import { normalizeArticleKey, normalizeBarcode } from "../utils.mjs";
import { buildBundleMovementPlan } from "../../../sborka/shared/bundle-movement-plan.mjs";

export { buildBundleMovementPlan };

let poolPromise = null;
let liveSchemaPromise = null;

const LIVE_EVENT_TYPES = new Set(["pick", "order_start", "order_complete", "handoff"]);

function uniqueTextList(values = []) {
  const out = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

function isLikelyBarcodeValue(value) {
  const normalized = normalizeBarcode(value).toUpperCase();
  if (!normalized) return false;
  if (/^\d{6,}$/.test(normalized)) return true;
  if (/^(OZN|MRKT|WB)[A-Z0-9-]{4,}$/.test(normalized)) return true;
  return false;
}

function normalizePickCellName(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/C/g, "С")
    .replace(/P/g, "П")
    .replace(/K/g, "К");
}

function parsePickCellSortValue(value) {
  const normalized = normalizePickCellName(value);
  const match = normalized.match(/^С(\d+)П(\d+)(?:К(\d+))?(.*)$/u);
  if (!match) {
    return {
      known: false,
      rack: Number.MAX_SAFE_INTEGER,
      shelf: Number.MAX_SAFE_INTEGER,
      box: Number.MAX_SAFE_INTEGER,
      tail: "",
      raw: normalized,
    };
  }
  return {
    known: true,
    rack: Number(match[1]),
    shelf: Number(match[2]),
    box: match[3] ? Number(match[3]) : -1,
    tail: match[4] || "",
    raw: normalized,
  };
}

function comparePickCellNames(left, right) {
  const a = parsePickCellSortValue(left);
  const b = parsePickCellSortValue(right);
  if (a.known !== b.known) return a.known ? -1 : 1;
  if (a.rack !== b.rack) return a.rack - b.rack;
  if (a.shelf !== b.shelf) return a.shelf - b.shelf;
  if (a.box !== b.box) return a.box - b.box;
  if (a.tail !== b.tail) {
    return a.tail.localeCompare(b.tail, "ru", { numeric: true, sensitivity: "base" });
  }
  return a.raw.localeCompare(b.raw, "ru", { numeric: true, sensitivity: "base" });
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

function getEquivalentProductSignature(product) {
  return JSON.stringify({
    article: normalizeArticleKey(product?.article || product?.code),
    code: normalizeArticleKey(product?.code || product?.article),
    name: String(product?.name || "").trim().toLowerCase(),
    barcodes: extractAllProductBarcodes(product).sort(),
  });
}

function canMergeEquivalentProducts(products = []) {
  if (!Array.isArray(products) || products.length <= 1) return false;
  return uniqueTextList(products.map((product) => getEquivalentProductSignature(product))).length === 1;
}

function filterProductsByArticle(products = [], article) {
  const normalizedArticle = normalizeArticleKey(article);
  if (!normalizedArticle) return products;
  const filtered = products.filter((product) => {
    const articleKey = normalizeArticleKey(product?.article);
    const codeKey = normalizeArticleKey(product?.code);
    return articleKey === normalizedArticle || codeKey === normalizedArticle;
  });
  return filtered.length ? filtered : products;
}

function wrapSkladError(error, message) {
  const wrapped = new Error(message || error?.message || "Складская БД недоступна");
  wrapped.cause = error;
  wrapped.isSkladDbAccessError = true;
  wrapped.isSkladMovementError = true;
  return wrapped;
}

export function isSkladMovementAccessError(error) {
  return Boolean(error?.isSkladDbAccessError);
}

async function ensureSborkaLiveSchema() {
  if (liveSchemaPromise) return liveSchemaPromise;
  liveSchemaPromise = (async () => {
    await skladQuery(
      `create table if not exists sborka_live_events_s (
         id serial primary key,
         employee_id integer not null,
         event_type varchar(50) not null,
         order_id varchar(255),
         product_name text,
         barcode varchar(255),
         quantity integer default 1,
         marketplace varchar(50),
         created_at timestamptz not null default now()
       )`,
      []
    );
    await skladQuery(
      "create index if not exists idx_sborka_live_employee on sborka_live_events_s (employee_id, created_at desc)",
      []
    );
    await skladQuery(
      "create index if not exists idx_sborka_live_created on sborka_live_events_s (created_at desc)",
      []
    );
  })().catch((error) => {
    liveSchemaPromise = null;
    throw error;
  });
  return liveSchemaPromise;
}

function makePool(useSsl) {
  return new Pool({
    host: SKLAD_DB_HOST,
    port: SKLAD_DB_PORT,
    user: SKLAD_DB_USER,
    password: SKLAD_DB_PASSWORD,
    database: SKLAD_DB_NAME,
    application_name: "sborka-sklad-movements",
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

async function withTransaction(work) {
  let pool = await getPool();
  let client = null;
  try {
    client = await pool.connect();
  } catch (error) {
    if (!isRetryablePgConnectionError(error) || String(error?.code || "").trim().toUpperCase() === "53300") {
      throw wrapSkladError(error);
    }
    await resetPool(pool);
    pool = await getPool();
    client = await pool.connect();
  }
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {}
    if (error?.isSkladDbAccessError) throw error;
    if (!error?.code && !error?.severity) throw error;
    throw wrapSkladError(error);
  } finally {
    client?.release();
  }
}

function normalizeWarehouseLookupToken(value) {
  return String(value || "").replace(/\s+/g, "").trim().toUpperCase();
}

function getWarehouseLookupAliases(value) {
  const normalized = normalizeWarehouseLookupToken(value);
  if (!normalized) return [];
  if (/^OZN\d+$/.test(normalized)) return [normalized, normalized.slice(3)];
  if (/^\d{6,}$/.test(normalized)) return [normalized, "OZN" + normalized];
  return [normalized];
}

function toWarehouseProductMeta(row = {}) {
  const entityType = String(row.entity_type || "").trim().toLowerCase() || null;
  return {
    id: row.id != null ? Number(row.id) : null,
    name: String(row.name || "").trim() || null,
    entityType,
    isBundle: entityType === "bundle",
    components: null, // [{ article, name, quantity }] — заполняется для комплектов
    jarCount: null, // суммарное число банок в комплекте
  };
}

function rememberWarehouseProductMeta(map, key, meta) {
  if (key && !map.has(key)) map.set(key, meta);
}

// Метаданные товаров из складской БД (products_s). Матч ПО БАРКОДУ
// (production_barcode / barcode_list / marketplace_barcodes_json), фолбэк по article/code.
// Токены — штрихкоды (OZN+sku, реальные ШК) и артикулы.
// Возвращает Map(UPPER(token) -> { name, entityType, isBundle }). Архивные исключены.
export async function resolveWarehouseProductMeta(tokens) {
  const keys = [
    ...new Set(
      (Array.isArray(tokens) ? tokens : [])
        .flatMap((token) => getWarehouseLookupAliases(token))
        .filter(Boolean)
    ),
  ];
  const map = new Map();
  if (!keys.length) return map;

  // A) по артикулу/коду (для товаров, чей склад-артикул совпадает с offer_id)
  const byArticle = await skladQuery(
    `select id, article, code, name, entity_type
       from products_s
      where coalesce(archived, false) = false
        and (
          upper(btrim(coalesce(article, ''))) = any($1::text[])
          or upper(btrim(coalesce(code, ''))) = any($1::text[])
        )`,
    [keys]
  );
  for (const row of byArticle.rows || []) {
    const meta = toWarehouseProductMeta(row);
    for (const key of getWarehouseLookupAliases(row.article)) rememberWarehouseProductMeta(map, key, meta);
    for (const key of getWarehouseLookupAliases(row.code)) rememberWarehouseProductMeta(map, key, meta);
  }

  // B) по штрихкоду — основной способ (маркетплейс даёт вариантные артикулы, связь по ШК)
  const byBarcode = await skladQuery(
    `select p.id,
            p.name,
            p.entity_type,
            upper(regexp_replace(coalesce(p.production_barcode, ''), '\\s+', '', 'g')) as pb,
            p.barcode_list,
            p.marketplace_barcodes_json
       from products_s p
      where coalesce(p.archived, false) = false
        and (
          upper(regexp_replace(coalesce(p.production_barcode, ''), '\\s+', '', 'g')) = any($1::text[])
          or exists (
            select 1 from regexp_split_to_table(coalesce(p.barcode_list, ''), ';') as raw_barcode(value)
            where upper(regexp_replace(btrim(raw_barcode.value), '\\s+', '', 'g')) = any($1::text[])
          )
          or exists (
            select 1 from jsonb_array_elements(
              case when jsonb_typeof(coalesce(p.marketplace_barcodes_json, '[]'::jsonb)) = 'array'
                   then coalesce(p.marketplace_barcodes_json, '[]'::jsonb) else '[]'::jsonb end
            ) as entry
            where upper(regexp_replace(coalesce(entry->>'value', ''), '\\s+', '', 'g')) = any($1::text[])
          )
        )`,
    [keys]
  );
  const keySet = new Set(keys);
  for (const row of byBarcode.rows || []) {
    const meta = toWarehouseProductMeta(row);
    const productBarcodes = new Set();
    if (row.pb) getWarehouseLookupAliases(row.pb).forEach((key) => productBarcodes.add(key));
    String(row.barcode_list || "").split(";").forEach((x) => {
      getWarehouseLookupAliases(x).forEach((key) => productBarcodes.add(key));
    });
    let arr = [];
    try {
      arr = Array.isArray(row.marketplace_barcodes_json)
        ? row.marketplace_barcodes_json
        : JSON.parse(row.marketplace_barcodes_json || "[]");
    } catch {}
    for (const entry of arr || []) {
      getWarehouseLookupAliases(entry?.value).forEach((key) => productBarcodes.add(key));
    }
    for (const key of productBarcodes) {
      if (keySet.has(key)) rememberWarehouseProductMeta(map, key, meta); // первая найденная связь остается стабильной
    }
  }

  // Состав комплектов (bundle_components_s): для каждого матч-товара с entity_type='bundle'
  // подтягиваем компоненты (что за банки и сколько). meta — общий объект для всех токенов,
  // поэтому мутируем его один раз по id комплекта.
  const bundleMetas = new Map(); // bundleId -> meta (уникальные)
  for (const meta of map.values()) {
    if (meta?.isBundle && Number.isInteger(meta.id) && meta.id > 0 && !bundleMetas.has(meta.id)) {
      bundleMetas.set(meta.id, meta);
    }
  }
  if (bundleMetas.size) {
    try {
      const comp = await skladQuery(
        `select bc.bundle_id, bc.quantity, c.article, c.name
           from bundle_components_s bc
           join products_s c on c.id = bc.component_id
          where bc.bundle_id = any($1::int[])
          order by bc.bundle_id, bc.id`,
        [[...bundleMetas.keys()]]
      );
      const byBundle = new Map();
      for (const row of comp.rows || []) {
        const bid = Number(row.bundle_id);
        if (!byBundle.has(bid)) byBundle.set(bid, []);
        byBundle.get(bid).push({
          article: String(row.article || "").trim() || null,
          name: String(row.name || "").trim() || null,
          quantity: Number(row.quantity) || 0,
        });
      }
      for (const [bid, meta] of bundleMetas) {
        const list = byBundle.get(bid) || [];
        meta.components = list;
        meta.jarCount = list.reduce((s, x) => s + (Number(x.quantity) || 0), 0) || null;
      }
    } catch (error) {
      // состав — не критично; комплект всё равно помечен isBundle
    }
  }
  return map;
}

// Названия товаров из складской БД (products_s). Сохранено для старых вызовов.
export async function addWarehouseProductBarcode({ productId, barcode } = {}) {
  const normalizedProductId = Number(productId || 0);
  const normalizedBarcode = normalizeBarcode(barcode);
  if (!Number.isInteger(normalizedProductId) || normalizedProductId <= 0) {
    throw new Error("Складская карточка товара не определена");
  }
  if (!normalizedBarcode || !isLikelyBarcodeValue(normalizedBarcode)) {
    throw new Error("Отсканированный штрихкод некорректен");
  }

  return withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [normalizedBarcode]);
    const targetResult = await client.query(
      `select *
       from products_s
       where id = $1 and coalesce(archived, false) = false
       for update`,
      [normalizedProductId]
    );
    const target = targetResult.rows?.[0] || null;
    if (!target) throw new Error("Товар не найден в складской системе");

    const barcodeMatches = await findProductsByBarcode(client, normalizedBarcode);
    const conflictingProducts = barcodeMatches.filter((product) => Number(product.id) !== normalizedProductId);
    if (conflictingProducts.length) {
      const conflict = conflictingProducts[0];
      const error = new Error(
        `Штрихкод ${normalizedBarcode} уже привязан к товару ${conflict.article || conflict.code || conflict.id}`
      );
      error.isWarehouseBarcodeConflict = true;
      throw error;
    }

    const allBarcodes = extractAllProductBarcodes(target).map((value) => normalizeBarcode(value));
    if (allBarcodes.includes(normalizedBarcode)) {
      return {
        added: false,
        productId: normalizedProductId,
        article: target.article || target.code || null,
        name: target.name || null,
        barcode: normalizedBarcode,
      };
    }

    const barcodeList = uniqueTextList([
      ...String(target.barcode_list || "")
        .split(";")
        .map((value) => normalizeBarcode(value))
        .filter(Boolean),
      normalizedBarcode,
    ]);
    await client.query("update products_s set barcode_list = $2 where id = $1", [
      normalizedProductId,
      barcodeList.join(";"),
    ]);
    return {
      added: true,
      productId: normalizedProductId,
      article: target.article || target.code || null,
      name: target.name || null,
      barcode: normalizedBarcode,
    };
  });
}

export async function resolveWarehouseNames(tokens) {
  const metaMap = await resolveWarehouseProductMeta(tokens);
  const map = new Map();
  for (const [key, meta] of metaMap.entries()) {
    if (meta?.name) map.set(key, meta.name);
  }
  return map;
}

export async function getWarehouseProductAvailability(productIds, warehouseId = SKLAD_FBS_WAREHOUSE_ID) {
  const ids = [...new Set((productIds || []).map(Number).filter((value) => Number.isInteger(value) && value > 0))];
  const result = new Map();
  if (!ids.length) return result;
  const rows = await skladQuery(
    `select product_id, coalesce(sum(quantity), 0)::int as quantity
       from (
         select sbi.product_id, sbi.quantity
           from shelf_box_items_s sbi
           join shelf_boxes_s sb on sb.id = sbi.shelf_box_id
           join shelves_s s on s.id = sb.shelf_id
           join racks_s r on r.id = s.rack_id
          where r.warehouse_id = $1 and sbi.product_id = any($2::int[])

         union all

         select si.product_id, si.quantity
           from shelf_items_s si
           join shelves_s s on s.id = si.shelf_id
           join racks_s r on r.id = s.rack_id
          where r.warehouse_id = $1 and si.product_id = any($2::int[])
            and (
              coalesce(s.uses_boxes, false) = false
              or not exists (
                select 1 from shelf_box_items_s sbi
                join shelf_boxes_s sb on sb.id = sbi.shelf_box_id
                where sb.shelf_id = si.shelf_id
                  and sbi.product_id = si.product_id
                  and sbi.quantity > 0
              )
            )
       ) stock
      group by product_id`,
    [normalizeWarehouseId(warehouseId), ids]
  );
  for (const row of rows.rows || []) result.set(Number(row.product_id), Number(row.quantity || 0));
  for (const id of ids) if (!result.has(id)) result.set(id, 0);
  return result;
}

async function findProductsByBarcode(client, barcode) {
  const normalizedBarcode = normalizeBarcode(barcode);
  if (!normalizedBarcode || !isLikelyBarcodeValue(normalizedBarcode)) return [];
  const barcodeAliases = getWarehouseLookupAliases(normalizedBarcode);
  const result = await client.query(
    `select distinct p.*
     from products_s p
     where coalesce(p.archived, false) = false
       and (
         upper(regexp_replace(coalesce(p.production_barcode, ''), '\s+', '', 'g')) = any($1::text[])
         or exists (
           select 1
           from regexp_split_to_table(coalesce(p.barcode_list, ''), ';') as raw_barcode(value)
           where upper(regexp_replace(btrim(raw_barcode.value), '\s+', '', 'g')) = any($1::text[])
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
           where upper(regexp_replace(coalesce(entry->>'value', ''), '\s+', '', 'g')) = any($1::text[])
         )
       )
     order by p.id`,
    [barcodeAliases]
  );
  return result.rows || [];
}

async function findProductsByArticle(client, article) {
  const normalizedArticle = normalizeArticleKey(article);
  if (!normalizedArticle) return [];
  const result = await client.query(
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

async function resolveActorContext(client, externalEmployeeId) {
  const normalizedId = Number(externalEmployeeId || 0);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    throw new Error("Не удалось определить сотрудника в складской системе");
  }
  const result = await client.query(
    `select e.id as employee_id,
            e.full_name as employee_name,
            u.id as user_id,
            u.username
     from employees_s e
     left join users_s u on u.employee_id = e.id and coalesce(u.active, true) = true
     where e.external_employee_id = $1
       and coalesce(e.active, true) = true
     order by u.id nulls last
     limit 1`,
    [normalizedId]
  );
  const row = result.rows?.[0] || null;
  if (!row?.employee_id || !row?.user_id) {
    throw new Error("Сотрудник не найден в складской БД или не привязан к users_s");
  }
  return {
    employeeId: Number(row.employee_id),
    employeeName: row.employee_name || "",
    userId: Number(row.user_id),
    username: row.username || "",
  };
}

async function resolveLiveEmployeeContext(client, externalEmployeeId) {
  const normalizedId = Number(externalEmployeeId || 0);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    throw new Error("Не удалось определить сотрудника в складской системе");
  }
  const result = await client.query(
    `select e.id as employee_id,
            e.full_name as employee_name
     from employees_s e
     where e.external_employee_id = $1
       and coalesce(e.active, true) = true
     limit 1`,
    [normalizedId]
  );
  const row = result.rows?.[0] || null;
  if (!row?.employee_id) {
    throw new Error("Сотрудник не найден в employees_s складской БД");
  }
  return {
    employeeId: Number(row.employee_id),
    employeeName: row.employee_name || "",
  };
}

export async function writeSborkaLiveEvent(options = {}) {
  await ensureSborkaLiveSchema();
  const eventType = String(options?.eventType || "").trim().toLowerCase();
  if (!LIVE_EVENT_TYPES.has(eventType)) {
    throw new Error("Некорректный тип live-события");
  }
  const quantity = Math.max(1, Number(options?.quantity || 1));
  const orderId = String(options?.orderId || "").trim() || null;
  const productName = String(options?.productName || "").trim() || null;
  const barcode = normalizeBarcode(options?.barcode);
  const marketplace = String(options?.marketplace || "").trim().toLowerCase() || null;
  return withTransaction(async (client) => {
    const actor = await resolveLiveEmployeeContext(client, options?.externalEmployeeId);
    await client.query(
      `insert into sborka_live_events_s (
         employee_id, event_type, order_id, product_name, barcode, quantity, marketplace, created_at
       ) values ($1, $2, $3, $4, $5, $6, $7, now())`,
      [actor.employeeId, eventType, orderId, productName, barcode || null, quantity, marketplace]
    );
    return {
      ok: true,
      employeeId: actor.employeeId,
      employeeName: actor.employeeName,
      eventType,
      orderId,
    };
  });
}

async function resolveMovementProducts(client, options = {}) {
  const resolvedProductIds = Array.from(
    new Set(
      (Array.isArray(options?.resolvedProductIds) ? options.resolvedProductIds : [options?.resolvedProductIds])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
  if (resolvedProductIds.length) {
    return resolvedProductIds.map((id) => ({ id }));
  }
  const sourceBarcodes = uniqueTextList((Array.isArray(options?.barcodes) ? options.barcodes : []).map(normalizeBarcode));
  let products = [];
  for (const barcode of sourceBarcodes) {
    const matches = await findProductsByBarcode(client, barcode);
    if (matches.length) {
      products = matches;
      break;
    }
  }
  if (!products.length && options?.allowArticleFallback) {
    products = await findProductsByArticle(client, options?.article);
  }
  if (!products.length) {
    if (options?.skipUnavailable === true) return [];
    throw new Error("Товар не найден в складской БД по штрихкоду");
  }
  if (products.length > 1 && !canMergeEquivalentProducts(products)) {
    if (options?.skipUnavailable === true) return [];
    throw new Error("Штрихкод указывает на несколько разных товаров в складской БД");
  }
  return products;
}

async function resolveBundleMovementPlan(client, products, quantity) {
  const productIds = products
    .map((product) => Number(product?.id || 0))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (productIds.length !== 1) return null;
  const productResult = await client.query(
    `select id, article, name, entity_type
       from products_s
      where id = $1 and coalesce(archived, false) = false`,
    [productIds[0]]
  );
  const bundle = productResult.rows?.[0] || null;
  if (String(bundle?.entity_type || "").trim().toLowerCase() !== "bundle") return null;
  const componentResult = await client.query(
    `select bc.component_id, bc.quantity, p.article, p.name
       from bundle_components_s bc
       join products_s p on p.id = bc.component_id
      where bc.bundle_id = $1
        and coalesce(p.archived, false) = false
      order by bc.id`,
    [productIds[0]]
  );
  const items = buildBundleMovementPlan(quantity, componentResult.rows);
  if (!items.length) {
    throw new Error(`У комплекта ${bundle.article || bundle.name || productIds[0]} не заполнен состав`);
  }
  return {
    bundleId: productIds[0],
    article: bundle.article || null,
    name: bundle.name || null,
    parentQuantity: quantity,
    componentQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
    items,
  };
}

export async function inspectResolvedMovementPlan(options = {}) {
  const quantity = Math.max(1, Number(options?.quantity || 1));
  return withTransaction(async (client) => {
    const products = await resolveMovementProducts(client, options);
    const bundle = await resolveBundleMovementPlan(client, products, quantity);
    if (bundle) return { kind: "bundle", ...bundle };
    return {
      kind: "product",
      parentQuantity: quantity,
      productIds: products.map((product) => Number(product.id)).filter((id) => Number.isInteger(id) && id > 0),
    };
  });
}

async function moveBundleFromShelfToEmployee(client, actor, plan, options = {}) {
  const skipUnavailable = options?.skipUnavailable === true;
  const preventNegative = options?.preventNegative !== false;
  const movementSource = String(options?.idempotencyKey || options?.source || "scan");
  const prepared = [];
  for (const item of plan.items) {
    const shelfRows = await listShelfRows(client, [item.productId], options?.warehouseId);
    const positiveRows = [...shelfRows]
      .filter((row) => row.quantity > 0)
      .sort((left, right) => comparePickCellNames(left.shelfName, right.shelfName));
    const available = positiveRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const fallbackShelf = buildFallbackShelf(shelfRows, null);
    if (available < item.quantity && skipUnavailable) {
      return {
        ok: true,
        movedQuantity: 0,
        skippedQuantity: plan.parentQuantity,
        componentMovedQuantity: 0,
        componentSkippedQuantity: plan.componentQuantity,
        bundleExpanded: true,
        missingComponent: item.article || item.productId,
      };
    }
    if (available < item.quantity && preventNegative) {
      throw new Error(`Недостаточно компонента ${item.article || item.productId} на складе: не хватает ${item.quantity - available} шт.`);
    }
    if (available < item.quantity && !fallbackShelf) {
      throw new Error(`Не удалось определить ячейку компонента ${item.article || item.productId}`);
    }
    prepared.push({ ...item, positiveRows, fallbackShelf });
  }

  let componentMovedQuantity = 0;
  for (const item of prepared) {
    let remaining = item.quantity;
    for (const row of item.positiveRows) {
      if (remaining <= 0) break;
      const delta = Math.min(remaining, row.quantity);
      const { before, after } = row.locationType === "shelf_box" && row.shelfBoxId
        ? await setShelfBoxQuantityDelta(client, row.shelfBoxId, row.productId, -delta)
        : await setShelfQuantityDelta(client, row.shelfId, row.productId, -delta);
      if (preventNegative && before < delta) {
        throw new Error(`Остаток компонента ${item.article || item.productId} изменился во время сборки. Повторите сканирование.`);
      }
      await addEmployeeInventory(client, actor.employeeId, row.productId, delta);
      await insertShelfMovement(client, {
        shelfId: row.shelfId,
        productId: row.productId,
        quantityBefore: before,
        quantityAfter: after,
        quantityDelta: -delta,
        userId: actor.userId,
        source: movementSource,
        notes: options?.notes || `Автоперемещение компонента комплекта ${plan.article || plan.bundleId}`,
      });
      await insertMovement(client, {
        movementType: "shelf_to_employee",
        productId: row.productId,
        quantity: delta,
        fromShelfId: row.shelfId,
        fromShelfBoxId: row.shelfBoxId,
        toEmployeeId: actor.employeeId,
        performedBy: actor.userId,
        source: movementSource,
        notes: options?.notes || `Автоперемещение компонента комплекта ${plan.article || plan.bundleId}`,
      });
      remaining -= delta;
      componentMovedQuantity += delta;
    }
    if (remaining > 0) {
      const target = item.fallbackShelf;
      const { before, after } = target.shelfBoxId
        ? await setShelfBoxQuantityDelta(client, target.shelfBoxId, item.productId, -remaining)
        : await setShelfQuantityDelta(client, target.shelfId, item.productId, -remaining);
      await addEmployeeInventory(client, actor.employeeId, item.productId, remaining);
      await insertShelfMovement(client, {
        shelfId: target.shelfId,
        productId: item.productId,
        quantityBefore: before,
        quantityAfter: after,
        quantityDelta: -remaining,
        userId: actor.userId,
        source: movementSource,
        notes: options?.negativeNotes || options?.notes || `Компонент комплекта ${plan.article || plan.bundleId}: отрицательный остаток`,
      });
      await insertMovement(client, {
        movementType: "shelf_to_employee",
        productId: item.productId,
        quantity: remaining,
        fromShelfId: target.shelfId,
        fromShelfBoxId: target.shelfBoxId,
        toEmployeeId: actor.employeeId,
        performedBy: actor.userId,
        source: movementSource,
        notes: options?.negativeNotes || options?.notes || `Компонент комплекта ${plan.article || plan.bundleId}: отрицательный остаток`,
      });
      componentMovedQuantity += remaining;
    }
  }
  return {
    ok: true,
    movedQuantity: plan.parentQuantity,
    skippedQuantity: 0,
    componentMovedQuantity,
    componentSkippedQuantity: 0,
    bundleExpanded: true,
  };
}

async function writeOffBundleEmployeeInventory(client, actor, plan, options = {}) {
  const skipUnavailable = options?.skipUnavailable === true;
  const preventNegative = options?.preventNegative !== false;
  const movementSource = String(options?.idempotencyKey || options?.source || "scan");
  const productIds = plan.items.map((item) => item.productId);
  const inventoryResult = await client.query(
    `select product_id, quantity
       from employee_inventory_s
      where employee_id = $1 and product_id = any($2::int[])
      order by product_id
      for update`,
    [actor.employeeId, productIds]
  );
  const balances = new Map(inventoryResult.rows.map((row) => [Number(row.product_id), Number(row.quantity || 0)]));
  const shortage = plan.items.find((item) => Math.max(0, balances.get(item.productId) || 0) < item.quantity);
  if (shortage && skipUnavailable) {
    return {
      ok: true,
      writtenOffQuantity: 0,
      skippedQuantity: plan.parentQuantity,
      componentWrittenOffQuantity: 0,
      componentSkippedQuantity: plan.componentQuantity,
      bundleExpanded: true,
      missingComponent: shortage.article || shortage.productId,
    };
  }
  if (shortage && preventNegative) {
    const available = Math.max(0, balances.get(shortage.productId) || 0);
    throw new Error(`Недостаточно компонента ${shortage.article || shortage.productId} у сотрудника: не хватает ${shortage.quantity - available} шт.`);
  }
  let componentWrittenOffQuantity = 0;
  for (const item of plan.items) {
    await addEmployeeInventory(client, actor.employeeId, item.productId, -item.quantity);
    await insertMovement(client, {
      movementType: "employee_writeoff",
      productId: item.productId,
      quantity: item.quantity,
      fromEmployeeId: actor.employeeId,
      performedBy: actor.userId,
      source: movementSource,
      notes: options?.notes || `Автосписание компонента комплекта ${plan.article || plan.bundleId}`,
    });
    componentWrittenOffQuantity += item.quantity;
  }
  return {
    ok: true,
    writtenOffQuantity: plan.parentQuantity,
    skippedQuantity: 0,
    componentWrittenOffQuantity,
    componentSkippedQuantity: 0,
    bundleExpanded: true,
  };
}

function normalizeWarehouseId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : SKLAD_FBS_WAREHOUSE_ID;
}

async function listShelfRows(client, productIds, warehouseId = SKLAD_FBS_WAREHOUSE_ID) {
  if (!productIds.length) return [];
  const resolvedWarehouseId = normalizeWarehouseId(warehouseId);
  const result = await client.query(
    `select *
     from (
       select
         'shelf_box'::text as location_type,
         sb.shelf_id,
         sbi.shelf_box_id,
         sbi.product_id,
         sbi.quantity,
         coalesce(
           nullif(btrim(sb.name), ''),
           concat(
             coalesce(nullif(btrim(s.code), ''), nullif(btrim(s.name), ''), s.id::text),
             'К',
             coalesce(nullif(sb.position::text, ''), sb.id::text)
           )
         ) as shelf_name,
         r.number as rack_number,
         s.number as shelf_number
       from shelf_box_items_s sbi
       join shelf_boxes_s sb on sb.id = sbi.shelf_box_id
       join shelves_s s on s.id = sb.shelf_id
       join racks_s r on r.id = s.rack_id
       where r.warehouse_id = $1
         and sbi.product_id = any($2::int[])

       union all

       select
         'shelf'::text as location_type,
         si.shelf_id,
         null::int as shelf_box_id,
         si.product_id,
         si.quantity,
         coalesce(nullif(btrim(s.code), ''), nullif(btrim(s.name), ''), s.id::text) as shelf_name,
         r.number as rack_number,
         s.number as shelf_number
       from shelf_items_s si
       join shelves_s s on s.id = si.shelf_id
       join racks_s r on r.id = s.rack_id
       where r.warehouse_id = $1
         and si.product_id = any($2::int[])
         and (
           coalesce(s.uses_boxes, false) = false
           or not exists (
             select 1
             from shelf_box_items_s sbi
             join shelf_boxes_s sb on sb.id = sbi.shelf_box_id
             where sb.shelf_id = si.shelf_id
               and sbi.product_id = si.product_id
               and sbi.quantity > 0
           )
         )
     ) locations
     order by rack_number nulls last, shelf_number nulls last, shelf_name, product_id`,
    [resolvedWarehouseId, productIds]
  );
  return (result.rows || []).map((row) => ({
    locationType: row.location_type || "shelf",
    shelfId: Number(row.shelf_id),
    shelfBoxId: Number(row.shelf_box_id || 0) || null,
    productId: Number(row.product_id),
    quantity: Number(row.quantity || 0),
    shelfName: row.shelf_name || "",
  }));
}

async function addEmployeeInventory(client, employeeId, productId, delta) {
  const result = await client.query(
    `insert into employee_inventory_s (employee_id, product_id, quantity, updated_at)
     values ($1, $2, $3, now())
     on conflict (employee_id, product_id)
     do update set quantity = employee_inventory_s.quantity + excluded.quantity,
                   updated_at = now()
     returning quantity`,
    [employeeId, productId, delta]
  );
  return Number(result.rows?.[0]?.quantity || 0);
}

async function setShelfQuantityDelta(client, shelfId, productId, delta) {
  const beforeResult = await client.query(
    `select quantity
     from shelf_items_s
     where shelf_id = $1 and product_id = $2
     for update`,
    [shelfId, productId]
  );
  const before = Number(beforeResult.rows?.[0]?.quantity || 0);
  const after = before + delta;
  await client.query(
    `insert into shelf_items_s (shelf_id, product_id, quantity, updated_at)
     values ($1, $2, $3, now())
     on conflict (shelf_id, product_id)
     do update set quantity = shelf_items_s.quantity + excluded.quantity,
                   updated_at = now()`,
    [shelfId, productId, delta]
  );
  return { before, after };
}

async function setShelfBoxQuantityDelta(client, shelfBoxId, productId, delta) {
  const beforeResult = await client.query(
    `select quantity
     from shelf_box_items_s
     where shelf_box_id = $1 and product_id = $2
     for update`,
    [shelfBoxId, productId]
  );
  const before = Number(beforeResult.rows?.[0]?.quantity || 0);
  const after = before + delta;
  await client.query(
    `insert into shelf_box_items_s (shelf_box_id, product_id, quantity, updated_at)
     values ($1, $2, $3, now())
     on conflict (shelf_box_id, product_id)
     do update set quantity = shelf_box_items_s.quantity + excluded.quantity,
                   updated_at = now()`,
    [shelfBoxId, productId, delta]
  );
  await client.query(
    `update shelf_boxes_s
     set quantity = greatest(0, coalesce(quantity, 0) + $2)
     where id = $1 and product_id = $3`,
    [shelfBoxId, delta, productId]
  );
  return { before, after };
}

function buildFallbackShelf(rows, preferredShelfId) {
  if (typeof preferredShelfId === "string" && preferredShelfId.trim()) {
    const [kind, rawId] = preferredShelfId.trim().split(":");
    const preferredLocationId = Number(rawId || 0);
    if (kind === "shelf_box" && preferredLocationId > 0) {
      const preferred = rows.find((row) => row.locationType === "shelf_box" && Number(row.shelfBoxId) === preferredLocationId);
      if (preferred) return preferred;
    }
    if (kind === "shelf" && preferredLocationId > 0) {
      const preferred = rows.find((row) => row.locationType === "shelf" && Number(row.shelfId) === preferredLocationId);
      if (preferred) return preferred;
    }
  }
  if (preferredShelfId) {
    const preferred = rows.find((row) => Number(row.shelfId) === Number(preferredShelfId));
    if (preferred) return preferred;
  }
  const sorted = [...rows].sort((left, right) => comparePickCellNames(left.shelfName, right.shelfName));
  return sorted[sorted.length - 1] || null;
}

async function insertMovement(client, payload) {
  await client.query(
    `insert into movements_s (
       movement_type, product_id, quantity,
       from_shelf_id, from_shelf_box_id, from_employee_id, to_employee_id,
       performed_by, notes, source, created_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [
      payload.movementType,
      payload.productId,
      payload.quantity,
      payload.fromShelfId ?? null,
      payload.fromShelfBoxId ?? null,
      payload.fromEmployeeId ?? null,
      payload.toEmployeeId ?? null,
      payload.performedBy,
      payload.notes,
      payload.source,
    ]
  );
}

async function insertShelfMovement(client, payload) {
  await client.query(
    `insert into shelf_movements_s (
       shelf_id, product_id, operation_type,
       quantity_before, quantity_after, quantity_delta,
       user_id, notes, source, created_at
     ) values ($1, $2, 'stock_out', $3, $4, $5, $6, $7, $8, now())`,
    [
      payload.shelfId,
      payload.productId,
      payload.quantityBefore,
      payload.quantityAfter,
      payload.quantityDelta,
      payload.userId,
      payload.notes,
      payload.source,
    ]
  );
}

export async function moveProductFromShelfToEmployee(options = {}) {
  const quantity = Math.max(1, Number(options?.quantity || 1));
  const skipUnavailable = options?.skipUnavailable === true;
  const preventNegative = options?.preventNegative !== false;
  const idempotencyKey = String(options?.idempotencyKey || "").trim();
  return withTransaction(async (client) => {
    if (idempotencyKey) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [idempotencyKey]);
      const existing = await client.query(
        "select 1 from movements_s where source = $1 limit 1",
        [idempotencyKey]
      );
      if (existing.rowCount) {
        return { ok: true, movedQuantity: quantity, skippedQuantity: 0, idempotent: true };
      }
    }
    const actor = await resolveActorContext(client, options?.externalEmployeeId);
    const products = await resolveMovementProducts(client, options);
    const bundlePlan = await resolveBundleMovementPlan(client, products, quantity);
    if (bundlePlan) {
      return moveBundleFromShelfToEmployee(client, actor, bundlePlan, {
        ...options,
        source: idempotencyKey || options?.source,
      });
    }
    const productIds = products.map((product) => Number(product.id)).filter((value) => Number.isInteger(value) && value > 0);
    const shelfRows = await listShelfRows(client, productIds, options?.warehouseId);
    const positiveRows = [...shelfRows]
      .filter((row) => row.quantity > 0)
      .sort((left, right) => comparePickCellNames(left.shelfName, right.shelfName));
    const fallbackShelf = buildFallbackShelf(shelfRows, options?.preferredShelfId);
    if (!fallbackShelf && !options?.preferredShelfId && !skipUnavailable) {
      throw new Error("Не удалось определить ячейку склада для автоперемещения");
    }
    let remaining = quantity;
    for (const row of positiveRows) {
      if (remaining <= 0) break;
      const delta = Math.min(remaining, row.quantity);
      const { before, after } =
        row.locationType === "shelf_box" && row.shelfBoxId
          ? await setShelfBoxQuantityDelta(client, row.shelfBoxId, row.productId, -delta)
          : await setShelfQuantityDelta(client, row.shelfId, row.productId, -delta);
      await addEmployeeInventory(client, actor.employeeId, row.productId, delta);
      await insertShelfMovement(client, {
        shelfId: row.shelfId,
        productId: row.productId,
        quantityBefore: before,
        quantityAfter: after,
        quantityDelta: -delta,
        userId: actor.userId,
        source: idempotencyKey || options?.source || "scan",
        notes: options?.notes || "Автоперемещение товара с полки сотруднику",
      });
      await insertMovement(client, {
        movementType: "shelf_to_employee",
        productId: row.productId,
        quantity: delta,
        fromShelfId: row.shelfId,
        fromShelfBoxId: row.shelfBoxId,
        toEmployeeId: actor.employeeId,
        performedBy: actor.userId,
        source: idempotencyKey || options?.source || "scan",
        notes: options?.notes || "Автоперемещение товара с полки сотруднику",
      });
      remaining -= delta;
    }
    if (remaining > 0) {
      if (skipUnavailable) {
        return { ok: true, movedQuantity: quantity - remaining, skippedQuantity: remaining };
      }
      if (preventNegative) {
        throw new Error(`Недостаточно товара на складе: не хватает ${remaining} шт.`);
      }
      const targetShelfId = Number(fallbackShelf?.shelfId || options?.preferredShelfId || 0);
      const targetShelfBoxId = Number(fallbackShelf?.shelfBoxId || 0) || null;
      const targetProductId = Number(fallbackShelf?.productId || productIds[0] || 0);
      if ((!targetShelfId && !targetShelfBoxId) || !targetProductId) {
        throw new Error("Не удалось определить ячейку для отрицательного остатка");
      }
      const { before, after } =
        targetShelfBoxId
          ? await setShelfBoxQuantityDelta(client, targetShelfBoxId, targetProductId, -remaining)
          : await setShelfQuantityDelta(client, targetShelfId, targetProductId, -remaining);
      await addEmployeeInventory(client, actor.employeeId, targetProductId, remaining);
      await insertShelfMovement(client, {
        shelfId: targetShelfId || fallbackShelf?.shelfId,
        productId: targetProductId,
        quantityBefore: before,
        quantityAfter: after,
        quantityDelta: -remaining,
        userId: actor.userId,
        source: idempotencyKey || options?.source || "scan",
        notes: options?.negativeNotes || options?.notes || "Автоперемещение товара с отрицательным остатком",
      });
      await insertMovement(client, {
        movementType: "shelf_to_employee",
        productId: targetProductId,
        quantity: remaining,
        fromShelfId: targetShelfId || fallbackShelf?.shelfId,
        fromShelfBoxId: targetShelfBoxId,
        toEmployeeId: actor.employeeId,
        performedBy: actor.userId,
        source: idempotencyKey || options?.source || "scan",
        notes: options?.negativeNotes || options?.notes || "Автоперемещение товара с отрицательным остатком",
      });
    }
    return { ok: true, movedQuantity: quantity, skippedQuantity: 0 };
  });
}

async function writeOffEmployeeInventoryInTransaction(client, options = {}) {
  const quantity = Math.max(1, Number(options?.quantity || 1));
  const skipUnavailable = options?.skipUnavailable === true;
  const preventNegative = options?.preventNegative !== false;
  const actor = await resolveActorContext(client, options?.externalEmployeeId);
  const products = await resolveMovementProducts(client, options);
  const bundlePlan = await resolveBundleMovementPlan(client, products, quantity);
  if (bundlePlan) {
    return writeOffBundleEmployeeInventory(client, actor, bundlePlan, options);
  }
  const productIds = products.map((product) => Number(product.id)).filter((value) => Number.isInteger(value) && value > 0);
  const inventoryResult = await client.query(
    `select product_id, quantity
     from employee_inventory_s
     where employee_id = $1 and product_id = any($2::int[])
     order by product_id
     for update`,
    [actor.employeeId, productIds]
  );
  const rows = (inventoryResult.rows || []).map((row) => ({
    productId: Number(row.product_id),
    quantity: Number(row.quantity || 0),
  }));
  let remaining = quantity;
  for (const row of rows) {
    if (remaining <= 0) break;
    if (row.quantity <= 0) continue;
    const delta = Math.min(remaining, row.quantity);
    await addEmployeeInventory(client, actor.employeeId, row.productId, -delta);
    await insertMovement(client, {
      movementType: "employee_writeoff",
      productId: row.productId,
      quantity: delta,
      fromEmployeeId: actor.employeeId,
      performedBy: actor.userId,
      source: options?.source || "scan",
      notes: options?.notes || "Автосписание товара у сотрудника после сборки заказа",
    });
    remaining -= delta;
  }
  if (remaining > 0) {
    if (skipUnavailable) {
      return { ok: true, writtenOffQuantity: quantity - remaining, skippedQuantity: remaining };
    }
    if (preventNegative) {
      throw new Error(`Недостаточно товара у сотрудника: не хватает ${remaining} шт.`);
    }
    const fallbackProductId = Number(rows[0]?.productId || productIds[0] || 0);
    if (!fallbackProductId) {
      throw new Error("Не удалось определить товар для списания у сотрудника");
    }
    await addEmployeeInventory(client, actor.employeeId, fallbackProductId, -remaining);
    await insertMovement(client, {
      movementType: "employee_writeoff",
      productId: fallbackProductId,
      quantity: remaining,
      fromEmployeeId: actor.employeeId,
      performedBy: actor.userId,
      source: options?.source || "scan",
      notes: options?.negativeNotes || options?.notes || "Автосписание товара у сотрудника с уходом в минус",
    });
  }
  return { ok: true, writtenOffQuantity: quantity, skippedQuantity: 0 };
}

export async function writeOffEmployeeInventory(options = {}) {
  return withTransaction((client) => writeOffEmployeeInventoryInTransaction(client, options));
}

export async function writeOffEmployeeInventoryBatch(options = {}) {
  const items = Array.isArray(options?.items) ? options.items.filter(Boolean) : [];
  if (!items.length) return [];
  return withTransaction(async (client) => {
    const idempotencyKey = String(options?.idempotencyKey || "").trim();
    if (idempotencyKey) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [idempotencyKey]);
      const existing = await client.query(
        "select 1 from movements_s where source = $1 limit 1",
        [idempotencyKey]
      );
      if (existing.rowCount) {
        return [{ ok: true, idempotent: true }];
      }
    }
    const results = [];
    for (const item of items) {
      results.push(
        await writeOffEmployeeInventoryInTransaction(client, {
          ...options,
          ...item,
          source: idempotencyKey || item?.source || options?.source,
          items: undefined,
        })
      );
    }
    return results;
  });
}

export async function transferEmployeeInventory(options = {}) {
  const quantity = Math.max(1, Number(options?.quantity || 1));
  const skipUnavailable = options?.skipUnavailable === true;
  return withTransaction(async (client) => {
    const fromActor = await resolveActorContext(client, options?.fromExternalEmployeeId);
    const toActor = await resolveActorContext(client, options?.toExternalEmployeeId);
    if (fromActor.employeeId === toActor.employeeId) {
      return {
        ok: true,
        fromEmployeeId: fromActor.employeeId,
        toEmployeeId: toActor.employeeId,
        transferredQuantity: quantity,
      };
    }
    const products = await resolveMovementProducts(client, options);
    const productIds = products.map((product) => Number(product.id)).filter((value) => Number.isInteger(value) && value > 0);
    const inventoryResult = await client.query(
      `select product_id, quantity
       from employee_inventory_s
       where employee_id = $1 and product_id = any($2::int[])
       order by product_id
       for update`,
      [fromActor.employeeId, productIds]
    );
    const rows = (inventoryResult.rows || []).map((row) => ({
      productId: Number(row.product_id),
      quantity: Number(row.quantity || 0),
    }));
    let remaining = quantity;
    for (const row of rows) {
      if (remaining <= 0) break;
      if (row.quantity <= 0) continue;
      const delta = Math.min(remaining, row.quantity);
      await addEmployeeInventory(client, fromActor.employeeId, row.productId, -delta);
      await addEmployeeInventory(client, toActor.employeeId, row.productId, delta);
      await insertMovement(client, {
        movementType: "employee_transfer",
        productId: row.productId,
        quantity: delta,
        fromEmployeeId: fromActor.employeeId,
        toEmployeeId: toActor.employeeId,
        performedBy: toActor.userId,
        source: options?.source || "sborka_handoff",
        notes: options?.notes || "Передача товара между сотрудниками после сборки товара",
      });
      remaining -= delta;
    }
    if (remaining > 0) {
      if (skipUnavailable) {
        return {
          ok: true,
          fromEmployeeId: fromActor.employeeId,
          toEmployeeId: toActor.employeeId,
          transferredQuantity: quantity - remaining,
          skippedQuantity: remaining,
        };
      }
      const fallbackProductId = Number(rows[0]?.productId || productIds[0] || 0);
      if (!fallbackProductId) {
        throw new Error("Не удалось определить товар для передачи между сотрудниками");
      }
      await addEmployeeInventory(client, fromActor.employeeId, fallbackProductId, -remaining);
      await addEmployeeInventory(client, toActor.employeeId, fallbackProductId, remaining);
      await insertMovement(client, {
        movementType: "employee_transfer",
        productId: fallbackProductId,
        quantity: remaining,
        fromEmployeeId: fromActor.employeeId,
        toEmployeeId: toActor.employeeId,
        performedBy: toActor.userId,
        source: options?.source || "sborka_handoff",
        notes:
          options?.negativeNotes ||
          options?.notes ||
          "Передача товара между сотрудниками с уходом источника в минус",
      });
    }
    return {
      ok: true,
      fromEmployeeId: fromActor.employeeId,
      toEmployeeId: toActor.employeeId,
      transferredQuantity: quantity,
      skippedQuantity: 0,
    };
  });
}

export async function getStockProblemReport() {
  const [negativeShelves, negativeEmployees, leftoverEmployees] = await Promise.all([
    skladQuery(
      `select si.shelf_id,
              si.product_id,
              si.quantity,
              coalesce(nullif(btrim(s.code), ''), nullif(btrim(s.name), ''), s.id::text) as shelf_name,
              p.name as product_name,
              p.article,
              coalesce(last_move.employees, '') as employees,
              last_move.last_created_at
       from shelf_items_s si
       join shelves_s s on s.id = si.shelf_id
       join racks_s r on r.id = s.rack_id
       join products_s p on p.id = si.product_id
       left join lateral (
         select string_agg(distinct coalesce(e.full_name, u.username), ', ' order by coalesce(e.full_name, u.username)) as employees,
                max(m.created_at) as last_created_at
         from movements_s m
         left join employees_s e on e.id = m.to_employee_id
         left join users_s u on u.id = m.performed_by
         where m.from_shelf_id = si.shelf_id
           and m.product_id = si.product_id
           and m.source in ('wb_pick_scan', 'oz_pick_scan')
       ) last_move on true
       where r.warehouse_id = $1 and si.quantity < 0
       order by shelf_name, p.name, p.article`,
      [SKLAD_FBS_WAREHOUSE_ID]
    ),
    skladQuery(
      `select i.employee_id,
              e.external_employee_id,
              i.product_id,
              i.quantity,
              e.full_name as employee_name,
              p.name as product_name,
              p.article
       from employee_inventory_s i
       join employees_s e on e.id = i.employee_id
       join products_s p on p.id = i.product_id
       where i.quantity < 0
       order by e.full_name, p.name, p.article`
    ),
    skladQuery(
      `select i.employee_id,
              e.external_employee_id,
              i.product_id,
              i.quantity,
              e.full_name as employee_name,
              p.name as product_name,
              p.article
       from employee_inventory_s i
       join employees_s e on e.id = i.employee_id
       join products_s p on p.id = i.product_id
       where i.quantity > 0
       order by e.full_name, p.name, p.article`
    ),
  ]);

  return {
    warehouseId: SKLAD_FBS_WAREHOUSE_ID,
    generatedAt: new Date().toISOString(),
    negativeShelves: (negativeShelves.rows || []).map((row) => ({
      shelfId: Number(row.shelf_id),
      shelfName: row.shelf_name || "",
      productId: Number(row.product_id),
      productName: row.product_name || "",
      article: row.article || "",
      quantity: Number(row.quantity || 0),
      employees: row.employees ? row.employees.split(/\s*,\s*/).filter(Boolean) : [],
      lastMovementAt: row.last_created_at || null,
    })),
    negativeEmployees: (negativeEmployees.rows || []).map((row) => ({
      employeeId: Number(row.employee_id),
      externalEmployeeId: Number(row.external_employee_id || 0) || null,
      employeeName: row.employee_name || "",
      productId: Number(row.product_id),
      productName: row.product_name || "",
      article: row.article || "",
      quantity: Number(row.quantity || 0),
    })),
    leftoverEmployees: (leftoverEmployees.rows || []).map((row) => ({
      employeeId: Number(row.employee_id),
      externalEmployeeId: Number(row.external_employee_id || 0) || null,
      employeeName: row.employee_name || "",
      productId: Number(row.product_id),
      productName: row.product_name || "",
      article: row.article || "",
      quantity: Number(row.quantity || 0),
    })),
  };
}
