import { Pool } from "pg";
import {
  SKLAD_DB_HOST,
  SKLAD_DB_NAME,
  SKLAD_DB_PASSWORD,
  SKLAD_DB_PORT,
  SKLAD_DB_SSL,
  SKLAD_DB_USER,
  SKLAD_FBS_WAREHOUSE_ID,
} from "../server/config.mjs";

const pool = new Pool({
  host: SKLAD_DB_HOST,
  port: SKLAD_DB_PORT,
  user: SKLAD_DB_USER,
  password: SKLAD_DB_PASSWORD,
  database: SKLAD_DB_NAME,
  ssl: SKLAD_DB_SSL === "require" ? { rejectUnauthorized: false } : false,
  max: 1,
});

try {
  const summary = await pool.query(`
    select m.source,
           m.movement_type,
           count(*)::int as movement_rows,
           sum(m.quantity)::numeric as quantity,
           min(m.created_at) as first_at,
           max(m.created_at) as last_at
      from movements_s m
      join products_s p on p.id = m.product_id
     where lower(coalesce(p.entity_type, '')) = 'bundle'
       and m.source ~* '^(wb|oz|ym)'
     group by m.source, m.movement_type
     order by max(m.created_at) desc
  `);
  const articles = await pool.query(`
    select p.id,
           p.article,
           p.name,
           count(*)::int as movement_rows,
           sum(m.quantity)::numeric as quantity,
           min(m.created_at) as first_at,
           max(m.created_at) as last_at
      from movements_s m
      join products_s p on p.id = m.product_id
     where lower(coalesce(p.entity_type, '')) = 'bundle'
       and m.source ~* '^(wb|oz|ym)'
     group by p.id, p.article, p.name
     order by max(m.created_at) desc
  `);
  const integrity = await pool.query(`
    with active_bundles as (
      select id, article, name
        from products_s
       where lower(coalesce(entity_type, '')) = 'bundle'
         and coalesce(archived, false) = false
    ), component_stats as (
      select b.id,
             count(bc.id)::int as component_rows,
             count(*) filter (where bc.quantity <= 0)::int as invalid_quantity_rows,
             count(*) filter (where c.id is null or coalesce(c.archived, false))::int as missing_or_archived_rows,
             count(*) filter (where lower(coalesce(c.entity_type, '')) = 'bundle')::int as nested_bundle_rows
        from active_bundles b
        left join bundle_components_s bc on bc.bundle_id = b.id
        left join products_s c on c.id = bc.component_id
       group by b.id
    )
    select b.id, b.article, b.name,
           s.component_rows, s.invalid_quantity_rows, s.missing_or_archived_rows, s.nested_bundle_rows
      from active_bundles b
      join component_stats s on s.id = b.id
     where s.component_rows = 0
        or s.invalid_quantity_rows > 0
        or s.missing_or_archived_rows > 0
        or s.nested_bundle_rows > 0
     order by b.article, b.id
  `);
  const componentCells = await pool.query(`
    with active_components as (
      select c.id, c.article, c.name,
             string_agg(distinct b.article, ', ' order by b.article) as bundle_articles
        from products_s b
        join bundle_components_s bc on bc.bundle_id = b.id
        join products_s c on c.id = bc.component_id
       where lower(coalesce(b.entity_type, '')) = 'bundle'
         and coalesce(b.archived, false) = false
         and coalesce(c.archived, false) = false
       group by c.id, c.article, c.name
    ), locations as (
      select si.product_id, si.quantity
        from shelf_items_s si
        join shelves_s s on s.id = si.shelf_id
        join racks_s r on r.id = s.rack_id
       where r.warehouse_id = $1
      union all
      select sbi.product_id, sbi.quantity
        from shelf_box_items_s sbi
        join shelf_boxes_s sb on sb.id = sbi.shelf_box_id
        join shelves_s s on s.id = sb.shelf_id
        join racks_s r on r.id = s.rack_id
       where r.warehouse_id = $1
    )
    select c.id, c.article, c.name, c.bundle_articles,
           count(l.product_id)::int as location_rows,
           coalesce(sum(l.quantity), 0)::numeric as recorded_quantity
      from active_components c
      left join locations l on l.product_id = c.id
     group by c.id, c.article, c.name, c.bundle_articles
    having count(l.product_id) = 0
     order by c.article, c.id
  `, [SKLAD_FBS_WAREHOUSE_ID]);
  const bundleStock = await pool.query(`
    with bundle_balances as (
      select si.product_id, sum(si.quantity)::numeric as quantity
        from shelf_items_s si
       group by si.product_id
      union all
      select sbi.product_id, sum(sbi.quantity)::numeric as quantity
        from shelf_box_items_s sbi
       group by sbi.product_id
    )
    select p.id, p.article, p.name, sum(b.quantity)::numeric as recorded_quantity
      from bundle_balances b
      join products_s p on p.id = b.product_id
     where lower(coalesce(p.entity_type, '')) = 'bundle'
     group by p.id, p.article, p.name
    having sum(b.quantity) <> 0
     order by p.article, p.id
  `);
  const employeeBundleBalances = await pool.query(`
    select e.full_name, p.article, ei.quantity
      from employee_inventory_s ei
      join employees_s e on e.id = ei.employee_id
      join products_s p on p.id = ei.product_id
     where lower(coalesce(p.entity_type, '')) = 'bundle'
       and ei.quantity <> 0
     order by e.full_name, p.article
  `);
  console.log(JSON.stringify({
    summary: summary.rows,
    articles: articles.rows,
    integrityIssues: integrity.rows,
    componentsWithoutCell: componentCells.rows,
    nonzeroBundleCellBalances: bundleStock.rows,
    nonzeroEmployeeBundleBalances: employeeBundleBalances.rows,
    warehouseId: SKLAD_FBS_WAREHOUSE_ID,
  }, null, 2));
} finally {
  await pool.end();
}
