const checks = [
  ["oz", "http://127.0.0.1:3006/health"],
  ["wb", "http://127.0.0.1:3007/health"],
  ["sborka", "http://127.0.0.1:3008/sborka/health"],
];

let failed = false;

for (const [name, url] of checks) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    if (!response.ok) {
      failed = true;
      console.error(`${name}: ${response.status} ${text.slice(0, 160)}`);
      continue;
    }
    console.log(`${name}: ok ${response.status}`);
  } catch (error) {
    failed = true;
    console.error(`${name}: ${error?.message || error}`);
  }
}

if (failed) process.exit(1);
