import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { connectAuto, loadEnv, mainDbConfig, rootDir } from "./db-common.mjs";

loadEnv();

const login = (process.env.CREATE_SUPERADMIN_LOGIN || "superadmin").trim();
const displayName = (process.env.CREATE_SUPERADMIN_NAME || "Superadmin").trim();
const outputPath = process.env.CREATE_SUPERADMIN_OUTPUT || path.join(rootDir, "superadmin-access.txt");

if (!login) {
  throw new Error("CREATE_SUPERADMIN_LOGIN is empty");
}

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%+=?";
  let password = "";
  const bytes = crypto.randomBytes(28);
  for (const byte of bytes) {
    password += alphabet[byte % alphabet.length];
  }
  return password;
}

function createLocalPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

const password = generatePassword();
const { salt, hash } = createLocalPasswordHash(password);
const pool = await connectAuto(mainDbConfig());

let action = "created";
try {
  const existing = await pool.query(
    `select id
     from users
     where role = 'super_admin'
       and coalesce(auth_source, 'local') = 'local'
       and lower(surname) = lower($1)
     order by id
     limit 1`,
    [login]
  );

  const row = existing.rows?.[0];
  if (row?.id) {
    action = "updated";
    await pool.query(
      `update users
       set password_hash = $1,
           password_salt = $2,
           name = $3,
           position = null,
           site_code = null,
           auth_source = 'local',
           updated_at = now()
       where id = $4`,
      [hash, salt, displayName, Number(row.id)]
    );
    await pool.query("delete from sessions where user_id = $1", [Number(row.id)]).catch(() => {});
  } else {
    await pool.query(
      `insert into users (
         surname, name, role, position, password_hash, password_salt,
         created_at, updated_at, site_code, auth_source
       )
       values ($1, $2, 'super_admin', null, $3, $4, now(), now(), null, 'local')`,
      [login, displayName, hash, salt]
    );
  }
} finally {
  await pool.end();
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  [
    "Grasklad new sborka superadmin",
    `URL=http://<SERVER_HOST>/sborka/`,
    `LOGIN=${login}`,
    `PASSWORD=${password}`,
    "",
  ].join("\n"),
  { mode: 0o600 }
);

console.log(JSON.stringify({ action, login, outputPath }, null, 2));
