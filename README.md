# AI Status Monitor

Lightweight AI endpoint health checker extracted from the MIT-licensed
`BingZi-233/check-cx` provider checking logic.

It keeps the real streamed model request, randomized response challenge,
timeout, retry, concurrency, latency measurement and endpoint ping behavior.
It replaces Next.js, Supabase, the admin application and multi-node leader
election with a small Node.js HTTP service and an atomic local JSON store.

Endpoints:

- `GET /` and `GET /history`
- `GET /health`
- `GET /api/status`
- `GET /api/v1/status`

Configuration is loaded from `config/providers.json`. Keep this file outside
source control and restrict it to the service account because it contains API
keys.

Each provider supports two request modes:

- `"checkMode": "challenge"` sends a randomized question and validates the answer.
- `"checkMode": "simple"` sends `simplePrompt` (defaults to `"hi"`) and accepts any non-empty response.

Omitting `checkMode` keeps the original `challenge` behavior. See
`config/providers.example.json` for both forms.

The provided Compose file binds the combined status UI and checker to
`127.0.0.1:8099` for Nginx to expose.

Set `SHOW_OVERALL_ALERT=false` to hide the homepage overall-status alert panel
while keeping provider statuses, latency, history and incident records. The
panel is hidden by default.

Set `DEFAULT_GROUPS_EXPANDED=true` to open every provider group when the page
loads. Groups are expanded by default.

Page branding is configurable without changing source code:

- `SITE_TITLE` controls the browser page title.
- `SITE_BRAND` controls the header and breadcrumb name.
- `SITE_FOOTER_BRAND` controls the footer brand.

All three default to `AI Status Monitor`.

Copy `.env.example` to `.env` and adjust the values for a deployment. The
`.env` file is ignored by Git and should never contain API keys in a public
repository.
