import { connectAuto, loadEnv, mainDbConfig } from "./db-common.mjs";

loadEnv();

const pool = await connectAuto(mainDbConfig());
try {
  const result = await pool.query(
    `select id, surname as login, name, coalesce(auth_source, 'local') as auth_source
     from users
     where role = 'super_admin'
     order by id`
  );
  console.log(JSON.stringify({ superadmins: result.rows }, null, 2));
} finally {
  await pool.end();
}
