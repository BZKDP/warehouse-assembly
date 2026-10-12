import fs from "node:fs";

if (process.env.SERVER_PID) {
  const entries = fs.readFileSync(`/proc/${process.env.SERVER_PID}/environ`, "utf8").split("\0");
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator > 0) process.env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
}

const { getDispenserLaneState } = await import("../server/services/sklad-movements.mjs");
const state = await getDispenserLaneState({ warehouseName: "Дозатор" });
console.log(JSON.stringify(state, null, 2));
