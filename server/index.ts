import { startApp } from "./app";
import { loadConfig } from "./config";
import { createPiHost } from "./pi";

const config = loadConfig();
const app = startApp({ config, pi: await createPiHost() });

console.log(`clnk backend listening on ${app.url}`);
console.log(`Data: ${config.dataDir}`);
console.log(
  config.webDir ? `Web UI: ${config.webDir}` : "Web UI not built; API only.",
);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
