import { authDbConfig, connectAuto, loadEnv, mainDbConfig, publicConfig, skladDbConfig } from "./db-common.mjs";

loadEnv();

async function inspectMain() {
  const config = mainDbConfig();
  const pool = await connectAuto(config);
  try {
    const identity = await pool.query(
      "select current_database() as database, current_user as user, inet_server_addr()::text as server_addr"
    );
    const tables = await pool.query(
      `select
         to_regclass('public.users') is not null as users,
         to_regclass('public.supply_settings') is not null as supply_settings,
         to_regclass('public.ozon_assemblies') is not null as ozon_assemblies,
         to_regclass('public.site_locations') is not null as site_locations`
    );
    const counts = await pool.query(
      `select
         (select count(*)::int from users) as users,
         (select count(*)::int from supply_settings) as supply_settings,
         (select count(*)::int from ozon_assemblies) as ozon_assemblies`
    );
    return { config: publicConfig(config), identity: identity.rows[0], tables: tables.rows[0], counts: counts.rows[0] };
  } finally {
    await pool.end();
  }
}

async function inspectAuth() {
  const config = authDbConfig();
  const pool = await connectAuto(config);
  try {
    const identity = await pool.query("select current_database() as database, current_user as user");
    const counts = await pool.query(
      `select
         (select count(*)::int from users_d) as users_d,
         (select count(*)::int from employees_d) as employees_d`
    );
    return { config: publicConfig(config), identity: identity.rows[0], counts: counts.rows[0] };
  } finally {
    await pool.end();
  }
}

async function inspectSklad() {
  const config = skladDbConfig();
  const pool = await connectAuto(config);
  try {
    const identity = await pool.query("select current_database() as database, current_user as user");
    const warehouses = await pool.query(
      `select id, name, warehouse_type, active
       from warehouses_s
       where active is true
       order by id`
    );
    return { config: publicConfig(config), identity: identity.rows[0], warehouses: warehouses.rows };
  } finally {
    await pool.end();
  }
}

const result = {
  main: await inspectMain(),
  auth: await inspectAuth(),
  sklad: await inspectSklad(),
};

console.log(JSON.stringify(result, null, 2));
