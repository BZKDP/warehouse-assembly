import crypto from "node:crypto";

const BASIS = [
  ["phosphatidylserine", "Фосфатидилсерин", "04627174095104", "confirmed", null],
  ["quercetin", "Кверцетин", "04627174095081", "confirmed", null],
  ["nmn", "NMN", "04627174095142", "confirmed", null],
  ["inositol", "Инозитол", "04627174095135", "review", "Перед заказом подтвердите вариант инозитола для текущей партии"],
  ["lactoferrin", "Лактоферрин", "04627174095098", "confirmed", null],
  ["monolaurin_lysine", "Монолаурин + L-лизин", "04627174095074", "confirmed", null],
  ["d_mannose", "D-манноза", "04627174095111", "confirmed", null],
  ["resveratrol", "Ресвератрол", "04627174095067", "confirmed", null],
  ["berberine_chromium", "Берберин с пиколинатом хрома", "04627174095128", "confirmed", null],
  ["magnesium_b6", "Магний B6", "04627174095012", "review", "GTIN есть в каталоге; производственную партию нужно подтвердить"],
];

const basisByType = new Map(BASIS.map(([key, displayName, gtin, approvalStatus, note]) => [
  normalizeType(displayName),
  { key, displayName, gtin, approvalStatus, note },
]));

function normalizeType(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ");
}

function lookupToken(value) {
  return String(value || "").replace(/\s+/g, "").trim().toUpperCase();
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function isoDate(value) {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized ? normalized : null;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function manifestStatus({ requiredCodes, unresolvedUnits, hasReviewBasis, allDatesReady, confirmedAt }) {
  if (unresolvedUnits > 0) return "mapping_required";
  if (requiredCodes === 0) return "not_required";
  if (!allDatesReady) return "dates_required";
  if (confirmedAt) return "confirmed";
  if (hasReviewBasis) return "basis_confirmation_required";
  return "ready_for_confirmation";
}

export async function ensureChzSchema(dbQuery) {
  await dbQuery(
    `create table if not exists chz_product_basis (
       basis_key text primary key,
       display_name text not null,
       gtin text not null unique,
       product_group text not null default 'bio',
       template_id integer not null default 30,
       approval_status text not null,
       note text,
       enabled boolean not null default true,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now(),
       check (approval_status in ('confirmed', 'review', 'blocked'))
     )`,
    []
  );
  for (const [key, displayName, gtin, approvalStatus, note] of BASIS) {
    await dbQuery(
      `insert into chz_product_basis (basis_key, display_name, gtin, approval_status, note)
       values ($1, $2, $3, $4, $5)
       on conflict (basis_key) do update
       set display_name = excluded.display_name,
           gtin = excluded.gtin,
           approval_status = excluded.approval_status,
           note = excluded.note,
           updated_at = now()`,
      [key, displayName, gtin, approvalStatus, note]
    );
  }
  await dbQuery(
    `create table if not exists chz_manifests (
       id bigserial primary key,
       marketplace text not null,
       entity_id text not null,
       version integer not null,
       snapshot_hash text not null,
       status text not null default 'building',
       source_lines integer not null default 0,
       total_physical_units integer not null default 0,
       required_codes integer not null default 0,
       no_chz_units integer not null default 0,
       unresolved_units integer not null default 0,
       production_date date,
       expiration_date date,
       confirmed_at timestamptz,
       confirmed_by bigint references users(id) on delete set null,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now(),
       unique (marketplace, entity_id, version),
       unique (marketplace, entity_id, snapshot_hash)
     )`,
    []
  );
  await dbQuery(
    `create table if not exists chz_manifest_items (
       id bigserial primary key,
       manifest_id bigint not null references chz_manifests(id) on delete cascade,
       item_key text not null,
       source_order_id text,
       source_line_key text,
       source_article text,
       source_name text,
       source_quantity integer not null,
       warehouse_product_id bigint,
       warehouse_article text,
       warehouse_name text,
       warehouse_entity_type text,
       component_product_id bigint,
       component_article text,
       component_name text,
       component_quantity integer not null,
       honest_sign boolean,
       iz_type text,
       basis_key text references chz_product_basis(basis_key),
       gtin text,
       resolution text not null,
       issue text,
       created_at timestamptz not null default now(),
       unique (manifest_id, item_key)
     )`,
    []
  );
  await dbQuery("alter table chz_manifest_items add column if not exists source_order_id text", []);
  await dbQuery("alter table chz_manifest_items add column if not exists source_line_key text", []);
  await dbQuery("create index if not exists idx_chz_manifest_items_manifest on chz_manifest_items(manifest_id)", []);
  await dbQuery(
    `create table if not exists chz_manifest_batches (
       id bigserial primary key,
       manifest_id bigint not null references chz_manifests(id) on delete cascade,
       basis_key text not null references chz_product_basis(basis_key),
       iz_type text not null,
       gtin text not null,
       quantity integer not null,
       production_date date,
       expiration_date date,
       requires_review boolean not null default false,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now(),
       unique (manifest_id, basis_key),
       check (quantity > 0)
     )`,
    []
  );
  await dbQuery("create index if not exists idx_chz_manifest_batches_manifest on chz_manifest_batches(manifest_id)", []);
  await dbQuery(
    `create table if not exists chz_jobs (
       id bigserial primary key,
       manifest_id bigint not null references chz_manifests(id) on delete restrict,
       client_request_id text not null unique,
       state text not null default 'REQUESTED',
       basis_key text,
       gtin text,
       quantity integer not null,
       production_date date,
       expiration_date date,
       template_id integer not null default 30,
       release_method_type text not null default 'REAPPLY',
       payment_type integer not null default 1,
       external_order_id text,
       external_report_id text,
       last_error text,
       leased_by text,
       lease_token text,
       lease_until timestamptz,
       attempt_count integer not null default 0,
       worker_updated_at timestamptz,
       created_by bigint references users(id) on delete set null,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now(),
       check (quantity > 0)
     )`,
    []
  );
  await dbQuery("alter table chz_jobs add column if not exists basis_key text", []);
  await dbQuery("alter table chz_jobs add column if not exists gtin text", []);
  await dbQuery("alter table chz_jobs add column if not exists production_date date", []);
  await dbQuery("alter table chz_jobs add column if not exists expiration_date date", []);
  await dbQuery("alter table chz_jobs add column if not exists template_id integer not null default 30", []);
  await dbQuery("alter table chz_jobs add column if not exists release_method_type text not null default 'REAPPLY'", []);
  await dbQuery("alter table chz_jobs add column if not exists payment_type integer not null default 1", []);
  await dbQuery("alter table chz_jobs add column if not exists leased_by text", []);
  await dbQuery("alter table chz_jobs add column if not exists lease_token text", []);
  await dbQuery("alter table chz_jobs add column if not exists lease_until timestamptz", []);
  await dbQuery("alter table chz_jobs add column if not exists attempt_count integer not null default 0", []);
  await dbQuery("alter table chz_jobs add column if not exists worker_updated_at timestamptz", []);
  await dbQuery("create index if not exists idx_chz_jobs_manifest on chz_jobs(manifest_id, created_at)", []);
  await dbQuery("create index if not exists idx_chz_jobs_claim on chz_jobs(state, lease_until, id)", []);
  await dbQuery(
    `create table if not exists chz_code_allocations (
       id bigserial primary key,
       manifest_id bigint not null references chz_manifests(id) on delete restrict,
       job_id bigint not null references chz_jobs(id) on delete restrict,
       manifest_item_id bigint not null references chz_manifest_items(id) on delete restrict,
       source_order_id text not null,
       source_article text,
       component_product_id bigint,
       unit_index integer not null,
       code_index integer not null,
       status text not null default 'RESERVED',
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now(),
       unique (job_id, code_index),
       unique (manifest_item_id, unit_index),
       check (unit_index > 0),
       check (code_index >= 0)
     )`,
    []
  );
  await dbQuery("create index if not exists idx_chz_code_allocations_order on chz_code_allocations(manifest_id, source_order_id)", []);
  await dbQuery(
    `create table if not exists chz_worker_nonces (
       nonce text primary key,
       worker_id text not null,
       created_at timestamptz not null default now()
     )`,
    []
  );
  await dbQuery("create index if not exists idx_chz_worker_nonces_created on chz_worker_nonces(created_at)", []);
  await dbQuery(
    `create table if not exists chz_print_attempts (
       id bigserial primary key,
       manifest_id bigint not null references chz_manifests(id) on delete restrict,
       job_id bigint references chz_jobs(id) on delete set null,
       user_id bigint references users(id) on delete set null,
       workstation text,
       printer_name text,
       source_order_id text,
       printed_count integer not null default 0,
       result text not null,
       error text,
       reprint_reason text,
       created_at timestamptz not null default now()
     )`,
    []
  );
  await dbQuery("alter table chz_print_attempts add column if not exists source_order_id text", []);
  await dbQuery("alter table chz_print_attempts add column if not exists printed_count integer not null default 0", []);
  await dbQuery("alter table chz_print_attempts add column if not exists error text", []);
}

async function sourceRows(marketplace, entityId, dbQuery) {
  if (marketplace === "ozon") {
    const result = await dbQuery(
      `select posting_number::text as source_order_id,
              line_no::text as source_line_key,
              coalesce(offer_id, '') as article,
              coalesce(sku::text, '') as barcode,
              coalesce(name, '') as name,
              greatest(quantity, 1)::int as quantity
         from ozon_assembly_order_items
        where assembly_id = $1
        order by posting_number, line_no`,
      [entityId]
    );
    return result.rows || [];
  }
  if (marketplace === "wb") {
    const result = await dbQuery(
      `select wb_order_id::text as source_order_id,
              wb_order_id::text as source_line_key,
              coalesce(article, '') as article,
              coalesce(barcode, '') as barcode,
              coalesce(product_name, '') as name,
              greatest(quantity, 1)::int as quantity
         from supply_orders
        where supply_id = $1
        order by wb_order_id`,
      [entityId]
    );
    return result.rows || [];
  }
  throw new Error(`Unsupported CHZ marketplace: ${marketplace}`);
}

function selectMeta(row, resolved) {
  const candidates = [row.article, row.barcode]
    .map(lookupToken)
    .filter(Boolean)
    .map((key) => resolved.get(key))
    .filter(Boolean);
  const byId = new Map(candidates.map((meta) => [Number(meta.id), meta]));
  if (byId.size > 1) return { meta: null, issue: "Артикул и штрихкод ведут на разные складские карточки" };
  return { meta: byId.values().next().value || null, issue: null };
}

function physicalItems(meta, sourceQuantity) {
  if (!meta?.isBundle) return [{ ...meta, quantity: sourceQuantity }];
  if (!Array.isArray(meta.components) || !meta.components.length) return [];
  return meta.components.map((component) => ({
    ...component,
    quantity: sourceQuantity * integer(component.quantity),
  }));
}

export function buildManifestItems(rows, resolved) {
  const items = [];
  for (const row of rows) {
    const quantity = Math.max(1, integer(row.quantity, 1));
    const selected = selectMeta(row, resolved);
    const sourceOrderId = String(row.source_order_id || "").trim();
    const sourceLineKey = String(row.source_line_key || "").trim();
    const sourceKey = `${sourceOrderId}|${sourceLineKey}|${lookupToken(row.article)}|${lookupToken(row.barcode)}`;
    if (!selected.meta) {
      items.push({
        itemKey: stableHash([sourceKey, "unresolved"]).slice(0, 32),
        sourceOrderId: sourceOrderId || null,
        sourceLineKey: sourceLineKey || null,
        sourceArticle: row.article || null,
        sourceName: row.name || null,
        sourceQuantity: quantity,
        warehouseProductId: null,
        warehouseArticle: null,
        warehouseName: null,
        warehouseEntityType: null,
        componentProductId: null,
        componentArticle: null,
        componentName: null,
        componentQuantity: quantity,
        honestSign: null,
        izType: null,
        basisKey: null,
        gtin: null,
        resolution: "unresolved",
        issue: selected.issue || "Товар не связан со складской карточкой",
      });
      continue;
    }
    const meta = selected.meta;
    const physical = physicalItems(meta, quantity);
    if (!physical.length) {
      items.push({
        itemKey: stableHash([sourceKey, meta.id, "empty_bundle"]).slice(0, 32),
        sourceOrderId: sourceOrderId || null,
        sourceLineKey: sourceLineKey || null,
        sourceArticle: row.article || null,
        sourceName: row.name || null,
        sourceQuantity: quantity,
        warehouseProductId: meta.id,
        warehouseArticle: meta.article,
        warehouseName: meta.name,
        warehouseEntityType: meta.entityType,
        componentProductId: null,
        componentArticle: null,
        componentName: null,
        componentQuantity: quantity,
        honestSign: null,
        izType: null,
        basisKey: null,
        gtin: null,
        resolution: "unresolved",
        issue: "У складского комплекта не заполнен состав",
      });
      continue;
    }
    for (const component of physical) {
      const componentQuantity = Math.max(1, integer(component.quantity, 1));
      let resolution = "no_chz";
      let issue = null;
      let basis = null;
      if (component.isBundle) {
        resolution = "unresolved";
        issue = "Вложенный комплект требует отдельного раскрытия состава";
      } else if (component.honestSign) {
        basis = basisByType.get(normalizeType(component.izType));
        if (!component.izType) {
          resolution = "unresolved";
          issue = "У товара включён ЧЗ, но не заполнено поле «Тип ИЗ»";
        } else if (!basis) {
          resolution = "unresolved";
          issue = `Неизвестный тип ИЗ: ${component.izType}`;
        } else {
          resolution = basis.approvalStatus === "review" ? "review" : "required";
          issue = basis.note;
        }
      }
      items.push({
        itemKey: stableHash([sourceKey, meta.id, component.id || meta.id, component.article, component.izType]).slice(0, 32),
        sourceOrderId: sourceOrderId || null,
        sourceLineKey: sourceLineKey || null,
        sourceArticle: row.article || null,
        sourceName: row.name || null,
        sourceQuantity: quantity,
        warehouseProductId: meta.id,
        warehouseArticle: meta.article,
        warehouseName: meta.name,
        warehouseEntityType: meta.entityType,
        componentProductId: component.id || meta.id,
        componentArticle: component.article || meta.article,
        componentName: component.name || meta.name,
        componentQuantity,
        honestSign: Boolean(component.honestSign),
        izType: component.izType || null,
        basisKey: basis?.key || null,
        gtin: basis?.gtin || null,
        resolution,
        issue,
      });
    }
  }
  return items;
}

export function summarizeChzManifestItems(items) {
  const summary = {
    totalPhysicalUnits: 0,
    requiredCodes: 0,
    noChzUnits: 0,
    unresolvedUnits: 0,
    hasReviewBasis: false,
  };
  for (const item of items) {
    const quantity = Math.max(0, integer(item.componentQuantity));
    summary.totalPhysicalUnits += quantity;
    if (item.resolution === "required" || item.resolution === "review") summary.requiredCodes += quantity;
    else if (item.resolution === "no_chz") summary.noChzUnits += quantity;
    else summary.unresolvedUnits += quantity;
    if (item.resolution === "review") summary.hasReviewBasis = true;
  }
  return summary;
}

async function hydrateManifest(manifest, dbQuery) {
  if (!manifest) return null;
  const [itemsResult, batchesResult, printResult, jobsResult] = await Promise.all([
    dbQuery("select * from chz_manifest_items where manifest_id = $1 order by resolution desc, component_name, source_article", [manifest.id]),
    dbQuery(
      `select id, basis_key, iz_type, gtin, quantity, production_date,
              expiration_date, requires_review, created_at, updated_at
         from chz_manifest_batches
        where manifest_id = $1
        order by iz_type, basis_key`,
      [manifest.id]
    ),
    dbQuery(
      `select id, job_id, source_order_id, workstation, printer_name, printed_count,
              result, error, reprint_reason, created_at
         from chz_print_attempts where manifest_id = $1 order by id desc limit 500`,
      [manifest.id]
    ),
    dbQuery(
      `select id, client_request_id, state, basis_key, gtin, quantity,
              production_date, expiration_date, template_id, release_method_type,
              payment_type, external_order_id, external_report_id, last_error,
              created_at, updated_at
         from chz_jobs where manifest_id = $1 order by id`,
      [manifest.id]
    ),
  ]);
  return {
    ...manifest,
    items: itemsResult.rows || [],
    batches: batchesResult.rows || [],
    basisTotals: batchesResult.rows || [],
    jobs: jobsResult.rows || [],
    printAttempts: printResult.rows || [],
  };
}

export async function refreshChzManifest({ marketplace, entityId, dbQuery, resolveWarehouseProductMeta }) {
  const rows = await sourceRows(marketplace, entityId, dbQuery);
  const tokens = rows.flatMap((row) => [row.article, row.barcode]).filter(Boolean);
  const resolved = await resolveWarehouseProductMeta(tokens);
  const items = buildManifestItems(rows, resolved);
  const snapshot = items.map((item) => ({
    sourceOrderId: item.sourceOrderId,
    sourceLineKey: item.sourceLineKey,
    sourceArticle: item.sourceArticle,
    sourceQuantity: item.sourceQuantity,
    warehouseProductId: item.warehouseProductId,
    componentProductId: item.componentProductId,
    componentQuantity: item.componentQuantity,
    honestSign: item.honestSign,
    izType: item.izType,
    basisKey: item.basisKey,
    gtin: item.gtin,
    resolution: item.resolution,
    issue: item.issue,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const snapshotHash = stableHash(snapshot);
  const existing = await dbQuery(
    `select * from chz_manifests
      where marketplace = $1 and entity_id = $2 and snapshot_hash = $3
      order by version desc limit 1`,
    [marketplace, entityId, snapshotHash]
  );
  const totals = summarizeChzManifestItems(items);
  let manifest = existing.rows?.[0] || null;
  let finalStatus = null;
  if (manifest && manifest.status !== "building") return hydrateManifest(manifest, dbQuery);

  if (!manifest) {
    const previous = await dbQuery(
      `select * from chz_manifests where marketplace = $1 and entity_id = $2 order by version desc limit 1`,
      [marketplace, entityId]
    );
    const previousManifest = previous.rows?.[0] || null;
    const version = integer(previousManifest?.version) + 1;
    finalStatus = manifestStatus({
      requiredCodes: totals.requiredCodes,
      unresolvedUnits: totals.unresolvedUnits,
      hasReviewBasis: totals.hasReviewBasis,
      allDatesReady: totals.requiredCodes === 0,
      confirmedAt: null,
    });
    const inserted = await dbQuery(
      `insert into chz_manifests (
         marketplace, entity_id, version, snapshot_hash, status, source_lines,
         total_physical_units, required_codes, no_chz_units, unresolved_units,
         production_date, expiration_date
       ) values ($1,$2,$3,$4,'building',$5,$6,$7,$8,$9,$10,$11)
       on conflict (marketplace, entity_id, snapshot_hash) do nothing
       returning *`,
      [marketplace, entityId, version, snapshotHash, rows.length,
        totals.totalPhysicalUnits, totals.requiredCodes, totals.noChzUnits, totals.unresolvedUnits,
        previousManifest?.production_date || null, previousManifest?.expiration_date || null]
    );
    manifest = inserted.rows?.[0] || null;
    if (!manifest) {
      const concurrent = await dbQuery(
        `select * from chz_manifests where marketplace = $1 and entity_id = $2 and snapshot_hash = $3 limit 1`,
        [marketplace, entityId, snapshotHash]
      );
      manifest = concurrent.rows?.[0] || null;
      if (manifest?.status !== "building") return hydrateManifest(manifest, dbQuery);
    }
  }
  if (!manifest) throw new Error("Не удалось создать манифест ЧЗ");
  if (!finalStatus) {
    finalStatus = manifestStatus({
      requiredCodes: totals.requiredCodes,
      unresolvedUnits: totals.unresolvedUnits,
      hasReviewBasis: totals.hasReviewBasis,
      allDatesReady: totals.requiredCodes === 0,
      confirmedAt: null,
    });
  }
  for (const item of items) {
    await dbQuery(
      `insert into chz_manifest_items (
         manifest_id, item_key, source_order_id, source_line_key, source_article, source_name, source_quantity,
         warehouse_product_id, warehouse_article, warehouse_name, warehouse_entity_type,
         component_product_id, component_article, component_name, component_quantity,
         honest_sign, iz_type, basis_key, gtin, resolution, issue
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       on conflict (manifest_id, item_key) do nothing`,
      [manifest.id, item.itemKey, item.sourceOrderId, item.sourceLineKey, item.sourceArticle, item.sourceName, item.sourceQuantity,
        item.warehouseProductId, item.warehouseArticle, item.warehouseName, item.warehouseEntityType,
        item.componentProductId, item.componentArticle, item.componentName, item.componentQuantity,
        item.honestSign, item.izType, item.basisKey, item.gtin, item.resolution, item.issue]
    );
  }
  await dbQuery(
    `insert into chz_manifest_batches (
       manifest_id, basis_key, iz_type, gtin, quantity, requires_review
     )
     select manifest_id, basis_key, max(iz_type), gtin,
            sum(component_quantity)::int, bool_or(resolution = 'review')
       from chz_manifest_items
      where manifest_id = $1 and resolution in ('required', 'review')
      group by manifest_id, basis_key, gtin
     on conflict (manifest_id, basis_key) do update
       set iz_type = excluded.iz_type,
           gtin = excluded.gtin,
           quantity = excluded.quantity,
           requires_review = excluded.requires_review,
           updated_at = now()`,
    [manifest.id]
  );
  const dateReadiness = await dbQuery(
    `select count(*)::int as total,
            count(*) filter (where production_date is not null and expiration_date is not null)::int as ready
       from chz_manifest_batches where manifest_id = $1`,
    [manifest.id]
  );
  const batchCount = integer(dateReadiness.rows?.[0]?.total);
  const readyBatchCount = integer(dateReadiness.rows?.[0]?.ready);
  finalStatus = manifestStatus({
    requiredCodes: totals.requiredCodes,
    unresolvedUnits: totals.unresolvedUnits,
    hasReviewBasis: totals.hasReviewBasis,
    allDatesReady: totals.requiredCodes === 0 || (batchCount > 0 && batchCount === readyBatchCount),
    confirmedAt: null,
  });
  const completed = await dbQuery(
    `update chz_manifests
        set status = $2, source_lines = $3, total_physical_units = $4, required_codes = $5,
            no_chz_units = $6, unresolved_units = $7, updated_at = now()
      where id = $1 and status = 'building'
      returning *`,
    [manifest.id, finalStatus, rows.length, totals.totalPhysicalUnits, totals.requiredCodes, totals.noChzUnits, totals.unresolvedUnits]
  );
  if (completed.rows?.[0]) return hydrateManifest(completed.rows[0], dbQuery);
  const finishedElsewhere = await dbQuery("select * from chz_manifests where id = $1", [manifest.id]);
  return hydrateManifest(finishedElsewhere.rows?.[0] || manifest, dbQuery);
}

export async function setChzManifestDates({ marketplace, entityId, batches, productionDate, expirationDate, dbQuery }) {
  const latest = await dbQuery(
    `select * from chz_manifests where marketplace = $1 and entity_id = $2 order by version desc limit 1`,
    [marketplace, entityId]
  );
  const manifest = latest.rows?.[0];
  if (!manifest) throw new Error("Сначала сформируйте расчёт ЧЗ");
  const existingJobs = await dbQuery("select 1 from chz_jobs where manifest_id = $1 limit 1", [manifest.id]);
  if (existingJobs.rowCount) throw new Error("Даты нельзя менять после постановки выпуска в очередь");
  const existingBatches = await dbQuery(
    "select basis_key from chz_manifest_batches where manifest_id = $1 order by basis_key",
    [manifest.id]
  );
  const knownKeys = new Set((existingBatches.rows || []).map((row) => String(row.basis_key)));
  let requested = Array.isArray(batches) ? batches : [];
  if (!requested.length && knownKeys.size === 1) {
    requested = [{ basisKey: [...knownKeys][0], productionDate, expirationDate }];
  }
  if (!requested.length) throw new Error("Укажите даты отдельно для каждого типа ЧЗ");
  const normalized = requested.map((entry) => {
    const basisKey = String(entry?.basisKey || entry?.basis_key || "").trim();
    const production = isoDate(entry?.productionDate || entry?.production_date);
    const expiration = isoDate(entry?.expirationDate || entry?.expiration_date);
    if (!knownKeys.has(basisKey)) throw new Error(`Неизвестное основание ЧЗ: ${basisKey || "—"}`);
    if (!production || !expiration) throw new Error(`Укажите корректные даты для ${basisKey}`);
    if (expiration <= production) throw new Error(`Срок годности должен быть позже даты производства для ${basisKey}`);
    return { basisKey, production, expiration };
  });
  if (new Set(normalized.map((entry) => entry.basisKey)).size !== normalized.length) {
    throw new Error("Один тип ЧЗ передан несколько раз");
  }
  for (const entry of normalized) {
    await dbQuery(
      `update chz_manifest_batches
          set production_date = $3, expiration_date = $4, updated_at = now()
        where manifest_id = $1 and basis_key = $2`,
      [manifest.id, entry.basisKey, entry.production, entry.expiration]
    );
  }
  const readiness = await dbQuery(
    `select count(*)::int as total,
            count(*) filter (where production_date is not null and expiration_date is not null)::int as ready,
            bool_or(requires_review) as has_review
       from chz_manifest_batches where manifest_id = $1`,
    [manifest.id]
  );
  const batchTotal = integer(readiness.rows?.[0]?.total);
  const status = manifestStatus({
    requiredCodes: integer(manifest.required_codes),
    unresolvedUnits: integer(manifest.unresolved_units),
    hasReviewBasis: Boolean(readiness.rows?.[0]?.has_review),
    allDatesReady: batchTotal > 0 && batchTotal === integer(readiness.rows?.[0]?.ready),
    confirmedAt: null,
  });
  const updated = await dbQuery(
    `update chz_manifests
        set production_date = null, expiration_date = null,
            confirmed_at = null, confirmed_by = null, status = $3, updated_at = now()
      where marketplace = $1 and entity_id = $2 and id = $4
      returning *`,
    [marketplace, entityId, status, manifest.id]
  );
  return hydrateManifest(updated.rows?.[0], dbQuery);
}

export async function confirmChzManifest({ marketplace, entityId, userId, dbQuery }) {
  const latest = await dbQuery(
    `select * from chz_manifests where marketplace = $1 and entity_id = $2 order by version desc limit 1`,
    [marketplace, entityId]
  );
  const manifest = latest.rows?.[0];
  if (!manifest) throw new Error("Сначала сформируйте расчёт ЧЗ");
  if (integer(manifest.unresolved_units) > 0) throw new Error("Сначала устраните все ошибки сопоставления ЧЗ");
  if (integer(manifest.required_codes) <= 0) throw new Error("В поставке нет товаров, требующих ЧЗ");
  const batches = await dbQuery(
    `select basis_key, gtin, quantity, production_date, expiration_date
       from chz_manifest_batches where manifest_id = $1 order by basis_key`,
    [manifest.id]
  );
  if (!batches.rowCount) throw new Error("Не удалось сформировать партии ЧЗ");
  if ((batches.rows || []).some((batch) => !batch.production_date || !batch.expiration_date)) {
    throw new Error("Сначала укажите даты для каждого типа ЧЗ");
  }
  const missingOrders = await dbQuery(
    `select count(*)::int as count from chz_manifest_items
      where manifest_id = $1 and resolution in ('required', 'review')
        and coalesce(source_order_id, '') = ''`,
    [manifest.id]
  );
  if (integer(missingOrders.rows?.[0]?.count) > 0) {
    throw new Error("Обновите расчёт ЧЗ: старый расчёт не содержит привязку к заказам");
  }
  for (const batch of batches.rows || []) {
    const clientRequestId = `${marketplace}:${entityId}:v${integer(manifest.version)}:${batch.basis_key}:${batch.gtin}`;
    const jobResult = await dbQuery(
      `insert into chz_jobs (
         manifest_id, client_request_id, state, basis_key, gtin, quantity,
         production_date, expiration_date, template_id, release_method_type,
         payment_type, created_by
       ) values ($1,$2,'REQUESTED',$3,$4,$5,$6,$7,30,'REAPPLY',1,$8)
       on conflict (client_request_id) do update set client_request_id = excluded.client_request_id
       returning id, quantity`,
      [manifest.id, clientRequestId, batch.basis_key, batch.gtin, integer(batch.quantity),
        batch.production_date, batch.expiration_date, userId || null]
    );
    const job = jobResult.rows?.[0];
    if (!job) throw new Error(`Не удалось создать задание ЧЗ для ${batch.basis_key}`);
    await dbQuery(
      `insert into chz_code_allocations (
         manifest_id, job_id, manifest_item_id, source_order_id, source_article,
         component_product_id, unit_index, code_index
       )
       select $1, $2, expanded.manifest_item_id, expanded.source_order_id,
              expanded.source_article, expanded.component_product_id,
              expanded.unit_index,
              (row_number() over (
                order by expanded.source_order_id, expanded.manifest_item_id, expanded.unit_index
              ) - 1)::int
         from (
           select i.id as manifest_item_id, i.source_order_id, i.source_article,
                  i.component_product_id, units.unit_index
             from chz_manifest_items i
             cross join lateral generate_series(1, i.component_quantity) as units(unit_index)
            where i.manifest_id = $1 and i.basis_key = $3
              and i.resolution in ('required', 'review')
         ) expanded
       on conflict do nothing`,
      [manifest.id, job.id, batch.basis_key]
    );
    const allocationCount = await dbQuery(
      "select count(*)::int as count from chz_code_allocations where job_id = $1",
      [job.id]
    );
    if (integer(allocationCount.rows?.[0]?.count) !== integer(job.quantity)) {
      throw new Error(`Распределение ЧЗ для ${batch.basis_key} не совпало с количеством кодов`);
    }
  }
  const updated = await dbQuery(
    `update chz_manifests set status = 'confirmed', confirmed_at = now(), confirmed_by = $2, updated_at = now()
      where id = $1 returning *`,
    [manifest.id, userId || null]
  );
  return hydrateManifest(updated.rows?.[0], dbQuery);
}

export async function getChzOrderRequirements({ marketplace, entityId, orderIds, dbQuery }) {
  const normalizedIds = [...new Set((Array.isArray(orderIds) ? orderIds : [])
    .map((value) => String(value || "").trim()).filter(Boolean))];
  if (!normalizedIds.length) return { manifestStatus: "missing", jobsReady: false, counts: {} };
  const latest = await dbQuery(
    `select * from chz_manifests where marketplace = $1 and entity_id = $2 order by version desc limit 1`,
    [marketplace, entityId]
  );
  const manifest = latest.rows?.[0];
  if (!manifest) return { manifestStatus: "missing", jobsReady: false, counts: {} };
  const [countsResult, jobsResult] = await Promise.all([
    dbQuery(
      `select source_order_id, sum(component_quantity)::int as count
         from chz_manifest_items
        where manifest_id = $1 and source_order_id = any($2::text[])
          and resolution in ('required', 'review')
        group by source_order_id`,
      [manifest.id, normalizedIds]
    ),
    dbQuery(
      `select count(*)::int as total,
              count(*) filter (where state in ('UTILISED', 'PRINTED'))::int as ready
         from chz_jobs where manifest_id = $1`,
      [manifest.id]
    ),
  ]);
  const totalJobs = integer(jobsResult.rows?.[0]?.total);
  const readyJobs = integer(jobsResult.rows?.[0]?.ready);
  return {
    manifestStatus: manifest.status,
    jobsReady: totalJobs > 0 && totalJobs === readyJobs,
    counts: Object.fromEntries((countsResult.rows || []).map((row) => [String(row.source_order_id), integer(row.count)])),
  };
}

const WORKER_TRANSITIONS = new Map([
  ["CLAIMED", new Set(["SIGNER_READY", "FAILED"])],
  ["SIGNER_READY", new Set(["ORDER_SUBMITTING", "FAILED"])],
  ["ORDER_SUBMITTING", new Set(["ORDER_CREATED", "SUBMIT_UNKNOWN"])],
  ["ORDER_CREATED", new Set(["BUFFER_ACTIVE", "FAILED"])],
  ["BUFFER_ACTIVE", new Set(["CODES_RECEIVED", "FAILED"])],
  ["CODES_RECEIVED", new Set(["UTILISATION_SUBMITTING", "FAILED"])],
  ["UTILISATION_SUBMITTING", new Set(["UTILISATION_SUBMITTED", "UTILISATION_PENDING", "UTILISED", "UTILISATION_UNKNOWN"])],
  ["UTILISATION_SUBMITTED", new Set(["UTILISATION_PENDING", "UTILISED", "FAILED"])],
  ["UTILISATION_PENDING", new Set(["UTILISED", "FAILED"])],
  ["UTILISED", new Set(["PRINTED", "PRINT_FAILED"])],
  ["PRINT_FAILED", new Set(["PRINTED"])],
]);

const WORKER_FINAL_STATES = new Set(["UTILISED", "PRINTED", "FAILED", "SUBMIT_UNKNOWN", "UTILISATION_UNKNOWN"]);

function publicWorkerJob(row, allocations = []) {
  if (!row) return null;
  return {
    id: Number(row.id),
    manifestId: Number(row.manifest_id),
    marketplace: row.marketplace,
    entityId: row.entity_id,
    clientRequestId: row.client_request_id,
    state: row.state,
    basisKey: row.basis_key,
    gtin: row.gtin,
    quantity: integer(row.quantity),
    productionDate: row.production_date,
    expirationDate: row.expiration_date,
    templateId: integer(row.template_id, 30),
    releaseMethodType: row.release_method_type,
    paymentType: integer(row.payment_type, 1),
    externalOrderId: row.external_order_id,
    externalReportId: row.external_report_id,
    lastError: row.last_error,
    leasedBy: row.leased_by,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    attemptCount: integer(row.attempt_count),
    allocations: allocations.map((allocation) => ({
      orderId: allocation.source_order_id,
      sourceArticle: allocation.source_article,
      componentProductId: allocation.component_product_id == null ? null : Number(allocation.component_product_id),
      unitIndex: integer(allocation.unit_index),
      codeIndex: integer(allocation.code_index),
    })),
  };
}

async function hydrateWorkerJob(row, dbQuery) {
  if (!row) return null;
  const allocations = await dbQuery(
    `select source_order_id, source_article, component_product_id, unit_index, code_index
       from chz_code_allocations where job_id = $1 order by code_index`,
    [row.id]
  );
  return publicWorkerJob(row, allocations.rows || []);
}

export async function claimChzJob({ workerId, dbQuery, leaseSeconds = 300 }) {
  const normalizedWorkerId = String(workerId || "").trim().slice(0, 120);
  if (!normalizedWorkerId) throw new Error("workerId обязателен");
  const leaseToken = crypto.randomUUID();
  const seconds = Math.max(60, Math.min(900, integer(leaseSeconds, 300)));
  const claimed = await dbQuery(
    `with candidate as (
       select j.id
         from chz_jobs j
         where (
           j.state = 'REQUESTED' and (j.lease_until is null or j.lease_until < now())
         ) or (
           j.leased_by = $1 and j.state in (
             'CLAIMED', 'SIGNER_READY', 'ORDER_SUBMITTING', 'ORDER_CREATED', 'BUFFER_ACTIVE',
             'CODES_RECEIVED', 'UTILISATION_SUBMITTING', 'UTILISATION_SUBMITTED', 'UTILISATION_PENDING'
           )
         )
         order by case when j.leased_by = $1 then 0 else 1 end, j.id
        for update skip locked
        limit 1
     )
     update chz_jobs j
        set state = case when j.state = 'REQUESTED' then 'CLAIMED' else j.state end,
            leased_by = $1, lease_token = $2,
            lease_until = now() + ($3::int * interval '1 second'),
            attempt_count = j.attempt_count + 1, worker_updated_at = now(), updated_at = now()
       from candidate
      where j.id = candidate.id
      returning j.*,
                (select marketplace from chz_manifests where id = j.manifest_id) as marketplace,
                (select entity_id from chz_manifests where id = j.manifest_id) as entity_id`,
    [normalizedWorkerId, leaseToken, seconds]
  );
  return hydrateWorkerJob(claimed.rows?.[0], dbQuery);
}

export async function updateChzJob({ jobId, workerId, leaseToken, state, externalOrderId, externalReportId, error, dbQuery }) {
  const id = integer(jobId);
  const normalizedWorkerId = String(workerId || "").trim().slice(0, 120);
  const normalizedLeaseToken = String(leaseToken || "").trim();
  const nextState = String(state || "").trim().toUpperCase();
  if (id <= 0 || !normalizedWorkerId || !normalizedLeaseToken || !nextState) throw new Error("Некорректное обновление задания ЧЗ");
  const currentResult = await dbQuery("select * from chz_jobs where id = $1", [id]);
  const current = currentResult.rows?.[0];
  if (!current) throw new Error("Задание ЧЗ не найдено");
  if (String(current.leased_by || "") !== normalizedWorkerId || String(current.lease_token || "") !== normalizedLeaseToken) {
    throw new Error("Задание ЧЗ принадлежит другому worker");
  }
  const currentState = String(current.state || "").toUpperCase();
  if (nextState !== currentState && !WORKER_TRANSITIONS.get(currentState)?.has(nextState)) {
    throw new Error(`Недопустимый переход ЧЗ: ${currentState} -> ${nextState}`);
  }
  const isFinal = WORKER_FINAL_STATES.has(nextState);
  const updated = await dbQuery(
    `update chz_jobs
        set state = $4,
            external_order_id = coalesce($5, external_order_id),
            external_report_id = coalesce($6, external_report_id),
            last_error = $7,
            lease_until = case when $8 then null else now() + interval '5 minutes' end,
            worker_updated_at = now(), updated_at = now()
      where id = $1 and leased_by = $2 and lease_token = $3
      returning *`,
    [id, normalizedWorkerId, normalizedLeaseToken, nextState,
      String(externalOrderId || "").trim() || null,
      String(externalReportId || "").trim() || null,
      String(error || "").trim().slice(0, 4000) || null,
      isFinal]
  );
  if (!updated.rows?.[0]) throw new Error("Не удалось обновить задание ЧЗ");
  return hydrateWorkerJob(updated.rows[0], dbQuery);
}

export async function recordChzPrintAttempt({ jobId, workerId, sourceOrderId, workstation, printerName, printedCount, result, reprintReason, error, dbQuery }) {
  const id = integer(jobId);
  const normalizedWorkerId = String(workerId || "").trim().slice(0, 120);
  const orderId = String(sourceOrderId || "").trim().slice(0, 200);
  const normalizedResult = String(result || "").trim().toUpperCase();
  const count = Math.max(0, integer(printedCount));
  if (id <= 0 || !normalizedWorkerId || !orderId || !["PRINTED", "PRINT_FAILED"].includes(normalizedResult)) {
    throw new Error("Некорректный отчёт о печати ЧЗ");
  }
  const jobResult = await dbQuery(
    `select id, manifest_id, leased_by, state from chz_jobs where id = $1`,
    [id]
  );
  const job = jobResult.rows?.[0];
  if (!job) throw new Error("Задание ЧЗ не найдено");
  if (String(job.leased_by || "") !== normalizedWorkerId) throw new Error("Задание ЧЗ принадлежит другому worker");
  if (!["UTILISED", "PRINTED", "PRINT_FAILED"].includes(String(job.state || "").toUpperCase())) {
    throw new Error("Печать ЧЗ разрешена только после успешного ввода кодов в оборот");
  }
  const allocation = await dbQuery(
    `select count(*)::int as count from chz_code_allocations where job_id = $1 and source_order_id = $2`,
    [id, orderId]
  );
  const expected = integer(allocation.rows?.[0]?.count);
  if (expected <= 0 || count > expected) throw new Error("Отчёт печати не совпадает с распределением ЧЗ по заказу");
  const inserted = await dbQuery(
    `insert into chz_print_attempts (
       manifest_id, job_id, source_order_id, workstation, printer_name,
       printed_count, result, error, reprint_reason
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [job.manifest_id, id, orderId,
      String(workstation || "").trim().slice(0, 250) || null,
      String(printerName || "").trim().slice(0, 250) || null,
      count, normalizedResult, String(error || "").trim().slice(0, 2000) || null,
      String(reprintReason || "").trim().slice(0, 500) || null]
  );
  return inserted.rows?.[0] || null;
}
