# Editor review

The editor preserves the plan comparison, actual server scorecards and concept-design notice in
both modes. It discovers its mode with `GET /api/session` before presenting connection controls.

## Cloudflare read-only pilot

Sign in through Cloudflare Access. The server returns a verified `CloudSession` containing the
principal, JWT expiry in Unix milliseconds and assigned project choices. The editor prefills the
first assigned project and its first candidate ref; there is no hardcoded demo project ID.
Project membership allows review across the project. Ref suggestions are navigation aids, not an
authorization list. The server remains authoritative for membership and review authorization.

Session discovery and `POST /api/tools/review_option` use same-origin Access cookies, never a manual
Bearer token. A review is displayed only when `X-Or1-Principal-Id` matches the captured session and
the response still belongs to the current review generation. Input edits, expiry, session refresh
and identity changes invalidate reviews and discard late responses. Returning to the page by focus
or visibility change refreshes the session; overlapping refreshes are coalesced.

Acceptance and agent runs are disabled for every pilot member, including owners. The editor hides
acceptance controls and state, and its controller refuses both `accept()` and `retry()` in cloud
mode. Server option eligibility is not authorization to accept. There is no pending cloud
acceptance storage or recovery workflow in this milestone.

A public-host session 404, login redirect/HTML, malformed response, failed request or expired JWT
fails closed without exposing local credentials. Initial discovery and unknown-provenance errors
use neutral availability wording. For a known Access session, use **Refresh session** after login;
**Reload page** navigates through Access again. Failed discovery does not trigger an automatic retry
loop.

## Temporary public development demo

The isolated development deployment may return `authentication: "development-bypass"` in its
cloud session. An absent marker retains Access behavior; any other marker is malformed and fails
closed. The demo stays in cloud mode with the same read-only controller guards, cookie-only
requests, identity-header verification, review generations and expiry checks. The editor never
supplies a bypass token or falls back to local credentials on a public host.

A prominent notice identifies the public demo as synthetic-only, read-only and **not
Access-authenticated**, with its full expiry date, time and timezone. A memory-only expiry value
is retained solely for presentation through refreshing, unavailable and expired states. It grants
no authority: review still requires a current valid cloud session. Those states never claim Access
verification or ask demo viewers to log in. A valid Access discovery clears the demo presentation.
Expiry removes the review and discards late responses. The server owns the fixed, at-most-seven-day
demo lifetime and deployment isolation; editor rendering does not verify either deployment.

## Local owner workflow

Only an initial session 404 on `localhost`, `127.0.0.1` or IPv6 loopback selects the local workflow.
A known cloud session never degrades to local mode on a later 404. Run the local server on
127.0.0.1:4310 and `pnpm dev:editor` on localhost:5173. The Vite development proxy forwards `/api`
to the local server. Configure `OR1_OWNER_TOKEN` on the server, then paste it into the local owner
token field. Do not use client environment variables, URLs or repository files for credentials.

The local token is memory-only; local tool requests use a Bearer header and `credentials: "omit"`.
The existing exact acceptance intent, uncertain-response warning and same-token retry semantics
remain unchanged. Never close or reload a page with an unresolved local acceptance.

## Checks

Run `pnpm --filter @or1/editor test`, `pnpm --filter @or1/editor typecheck` and
`pnpm --filter @or1/editor build`. Before committing, also run the repository-wide `pnpm check`
and `pnpm test`. Session tests cover the local regression workflow, cookie-only cloud requests,
project/ref navigation, fail-closed discovery, principal mismatch, stale replies, expiry and
refresh/recovery. Hosted Access/backend verification is separate from synthetic editor rendering.
