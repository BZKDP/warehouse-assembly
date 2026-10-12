import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const root="/opt/grasklad-sborka";
function replaced(content,key,value){const pattern=new RegExp(`^\\s*${key}\\s*=.*$`,`m`);return pattern.test(content)?content.replace(pattern,`${key}=${value}`):`${content.replace(/\s*$/,"")}\n${key}=${value}\n`;}
const mainCurrent=fs.readFileSync(path.join(root,".env"),"utf8");
const ymCurrent=fs.readFileSync(path.join(root,".env.yandex"),"utf8");
const mainBefore=replaced(replaced(mainCurrent,"SKLAD_FBS_WAREHOUSE_ID","30"),"SKLAD_FBS_WAREHOUSE_NAME","Ижевск FBS нов");
const ymBefore=replaced(ymCurrent,"YANDEX_SKLAD_WAREHOUSE_ID","38");
const mainPath=path.join(root,"backups",".env.before-fbs46.20260909T102434MSK");
const ymPath=path.join(root,"backups",".env.yandex.before-fbs46.20260909T102434MSK");
fs.writeFileSync(mainPath,mainBefore,{mode:0o600});
fs.writeFileSync(ymPath,ymBefore,{mode:0o600});
fs.chmodSync(mainPath,0o600);fs.chmodSync(ymPath,0o600);
console.log(JSON.stringify({mainPath,ymPath,mainSha256:crypto.createHash("sha256").update(mainBefore).digest("hex"),ymSha256:crypto.createHash("sha256").update(ymBefore).digest("hex")},null,2));
