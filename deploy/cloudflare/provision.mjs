import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { startRemoteProxySession } from "wrangler";

// Pinned app dependency; the deployment tools are deliberately not runtime dependencies.
const require = createRequire(new URL("../../apps/cloudflare/package.json", import.meta.url));
const { convertV4MiniflareOptions, Miniflare } = require("miniflare");
const [configPath, tokenPath] = process.argv.slice(2);
if (!configPath || !tokenPath || process.argv.length !== 4)
  throw new Error("Usage: node deploy/cloudflare/provision.mjs CONFIG.json PRIVATE_TOKEN_FILE");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.name !== "or1" || config.vars?.PROVISIONER_ENABLED !== "true")
  throw new Error("Expected the or1 config with provisioning explicitly enabled");
const path = resolve(tokenPath);
const directory = await stat(dirname(path));
if (
  (await realpath(path)) !== path ||
  directory.uid !== process.getuid() ||
  (directory.mode & 0o777) !== 0o700
)
  throw new Error("Token must be in a private, user-owned directory without symlinks");
const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
let token;
try {
  const info = await file.stat();
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600)
    throw new Error("Token must be a regular user-owned 0600 file");
  token = (await file.readFile("utf8")).trim();
} finally {
  await file.close();
}
if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid API token file format");

let remote;
let local;
try {
  remote = await startRemoteProxySession(
    { ADMIN: { type: "service", service: "or1", entrypoint: "Provisioner", remote: true } },
    { auth: { accountId: config.account_id, apiToken: { apiToken: token } } },
  );
  // Local listeners are loopback-only. Wrangler's remote preview bridge is token-protected;
  // teardown does not revoke its preview token. Disable the deployed provisioner after seeding.
  local = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      name: "or1-private-provision-client",
      modules: true,
      script: "export default {}",
      compatibilityDate: config.compatibility_date,
      serviceBindings: {
        ADMIN: {
          name: "or1",
          entrypoint: "Provisioner",
          remoteProxyConnectionString: remote.remoteProxyConnectionString,
        },
      },
    }),
  );
  const { ADMIN } = await local.getBindings();
  const result = await ADMIN.seedSyntheticDemo();
  if (result.version !== "cloud-demo-v1" || result.projectId !== "demo-workspace")
    throw new Error("Unexpected provisioning response");
  console.log(JSON.stringify(result));
} finally {
  try {
    await local?.dispose();
  } finally {
    await remote?.dispose();
  }
}
