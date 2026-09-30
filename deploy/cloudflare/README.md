# Cloudflare read-only pilot

The first hosted release is a **synthetic-data review pilot**, not a hosted replacement for the
local owner/agent service. Workers serve the editor and route two APIs to project-scoped SQLite
Durable Objects. The same portable store engine and shared review registry run in Node and workerd.
No browser actor, including a cloud owner, can accept, generate, provision or edit a project.

## Configuration and protection

Use Node 24+, `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test`, and
`pnpm --filter @or1/editor build`. Native tests run actual workerd SQLite, not a Node SQL mock.
SQLite-backed Durable Objects are available on Workers Free; quotas still apply. This is not a
capacity claim for production-size projects or online model runs.

1. Create a self-hosted Cloudflare Access application for the **whole hostname**, with an explicit
   email allow policy. Do not add a bypass policy. Obtain its application audience and team issuer.
2. Copy `wrangler.example.jsonc` to a private deployment directory outside the repository. Replace
   the account, issuer, audience, domain and member placeholders. Resolve `main` and assets paths
   relative to that file (or use absolute paths). Keep `nodejs_compat`, SQLite migration tags,
   `workers_dev: false`, `preview_urls: false`, and API worker-first paths. Do not rewrite an existing
   migration or point this pilot at historical/client data.
3. `PROJECT_CONFIG` is JSON containing `defaultProjectId` and `projects`, each with `projectId`,
   display `label`, suggested `refs`, and explicit `{email,membership}` entries. Membership is
   project-wide; suggested refs are not authorization restrictions. Both owners and viewers can
   only review. Use the same owner email in Access and this configuration.
4. Keep the API token in a user-owned regular 0600 file in a 0700 directory outside the repository.
   Never put it in Wrangler vars, frontend env, URLs, shell arguments or browser storage. The
   deployment needs Workers edit, Access applications/policies edit, zone Workers routes edit and
   zone read permissions, scoped to the relevant account and zone. Revoke temporary broad tokens
   after verification. No paid plan or browser-rendering subscription is required.

Deploy with `pnpm exec wrangler deploy --config /private/path/wrangler.json`, supplying
`CLOUDFLARE_API_TOKEN` only to that child process from the private file (not as a literal shell
command). The custom-domain route creates its own DNS record. Access protection must exist first.
Do not manually create a conflicting DNS record or change unrelated Workers such as Claire.

## Private synthetic provisioning

The demo is a public synthetic rectangle with `option-a`, `option-b` and `incomplete` candidates.
No public fetch endpoint seeds data. Session discovery does not open or migrate a store.

For this initial provisioning only, set `PROVISIONER_ENABLED` to the string `"true"` in the private
configuration and deploy. Invoke the named `Provisioner` service-binding entrypoint:

```sh
node deploy/cloudflare/provision.mjs /private/path/wrangler.json /private/path/api-token
```

The helper uses the pinned Wrangler remote service-binding proxy and a short-lived loopback-only
Miniflare client. Wrangler also creates a temporary Internet-addressable edge-preview bridge,
protected by a separate preview token, outside the app hostname's Access policy. Anyone holding
that preview token can use its administrative binding while provisioning is enabled. Never log or
share preview credentials. Teardown closes local resources but does not revoke the preview token
(approximately one-hour lifetime); the app's disabled preview URLs do not disable this separate
transport. No permanent public admin Worker or application seed route is deployed.

This transport is used only for the authorized synthetic seed. Its fixed v1 commands replay their
original bases and request IDs through the registry; retries do not reset existing heads. Do not
change those identities to overwrite an unexpected existing project.

**Always set `PROVISIONER_ENABLED` back to `"false"` and redeploy**, including after an invocation
error. Replaying the seed before disabling should return the same version/project. To check the
disabled entrypoint, invoke it with a local config copy whose flag is true while the deployed flag
is false; the remote call must reject. This rejection is a required deployment completion check,
not optional cleanup. Delete the local enabled copy afterwards. Do not delete the Durable Object
namespace or state as a cleanup step.

## Verification and limits

- Anonymous requests to the custom domain must go through Access; verify the policy remains an
  exact allowlist. Workers.dev and version preview URLs must remain disabled.
- Sign in as an allowed member and inspect `/api/session`, then review all three candidates.
  Requests use Access cookies, not a global Bearer credential. The DO independently validates the
  signed JWT, derives a stable principal and checks membership before opening the store.
- Review responses are bounded, `no-store`, and carry `X-Or1-Principal-Id`. POST requires the exact
  configured HTTPS Origin. There is no CORS or public accept, run, MCP, generic tool or seed API.
- Check persistence across deployment and confirm provisioning is disabled. Native tests also
  cover transactional rollback, foreign keys, immutable revisions, exact replay, changes counts,
  auth failures, key rotation and project isolation.
- Synthetic JWT/native tests and mocked browser screenshots do **not** establish real-owner
  Access login or production capacity. Those checks must be reported separately.

The browser resets review state on expiry, identity changes and session refresh. Local acceptance
and exact uncertain-response retry still work on the loopback-only owner service; they are not
available on the cloud pilot. Real-data import, cloud acceptance/recovery and online agents require
separate reviewed milestones, backups and appropriate operational limits.

## Temporary development-only login bypass

This is a **public synthetic development demo**, not a production authentication exception.
Production `or1.orfloat.com` remains protected by its existing Access application and verified JWTs.
Do not add an Access bypass policy to production or export an owner's session credential.

The separate `or1-dev` Worker serves only `https://or1-dev.orfloat.com`, with its own SQLite DO
namespace. Use `wrangler.development.example.jsonc` outside the repository, preserving the exact
Worker/hostname pair, independent binding (no production `script_name`/service binding), and
`assets.run_worker_first: true`. Verify its namespace ID differs from production before seeding.
Only the single `demo-workspace` synthetic project is supported. Never import client data into it.
Anyone can read/copy this demo and consume its public request quota; isolation does not eliminate
account-level quota risk.

Enabling requires all of:

- `DEVELOPMENT_REVIEW_BYPASS: "true"` (the example is disabled by default).
- `DEPLOYMENT_ENVIRONMENT: "development"`.
- `PUBLIC_ORIGIN: "https://or1-dev.orfloat.com"` and that exact request origin.
- `DEVELOPMENT_REVIEW_EXPIRES_AT`: a **fixed decimal Unix-millisecond deadline**, strictly in the
  future and at most seven days ahead. Choose and record its UTC date/time explicitly. Ordinary
  refreshes, cold starts and redeploys must not reset or extend it.
- Exactly one configured/default project, `demo-workspace`.

The runtime refuses invalid, missing, expired, production-host or mismatched bypass configuration;
it never turns JWT failure into anonymous access. Anonymous dev sessions are explicitly marked
`authentication: "development-bypass"`, use a synthetic viewer principal and remain read-only.
Supplied owner JWTs or role headers cannot elevate them. Session discovery does not seed data;
provision the fixed demo privately using the dev configuration and the same helper, then disable
the provisioner and prove its RPC rejection. The helper validates approved Worker/origin pairs and
targets the selected Worker—not a hardcoded production service.

The editor prominently identifies public synthetic/non-Access authentication and the full expiry.
Expiry is checked on every request and after awaited work. Successful dev assets are `no-store`,
and Worker-first routing prevents APIs/assets from bypassing the deadline. Expiry cannot retract
previously downloaded public content.

**Removal condition and owner:** Akram must remove the bypass at the next sprint acceptance
review, or before any real data or hosted write/agent capability, whichever comes first. The fixed
seven-day limit is an automatic backstop, not permission to retain it through those events.
Remove the development custom-domain route or deploy a deny-only state; verify anonymous root,
assets and API requests are denied. Merely clearing the flag is not evidence the whole hostname
is offline. Preserve DO state rather than deleting it, and revoke temporary deployment credentials
separately. Re-enabling later requires a deliberate new reviewed deadline/deployment.
