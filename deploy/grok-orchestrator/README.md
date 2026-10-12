# FilmCraft Grok Orchestrator

This is a small Vercel API surface for the first Grok -> FilmCraft -> Supabase -> VerticalFlash flow.
It keeps Supabase and VerticalFlash credentials on the server and exposes password-protected HTTP routes
that Grok or an MCP bridge can call.

## Deploy on Vercel

### Preferred: repo-level Services deployment

The repository root now has a `vercel.json` that defines one public service:

```text
grok_orchestrator -> deploy/grok-orchestrator
```

In Vercel, set the project framework/preset to **Services** and deploy from the repository root. Public
requests under `/api/*` route to this service.

### Fallback: standalone deployment

If you do not want to use Vercel Services yet, import this repository and choose the root directory:

   ```text
   deploy/grok-orchestrator
   ```

Use the default Node/Other preset. This is an API-only deployment.

For either deployment mode:

1. Add the environment variables from `.env.example` in Vercel Project Settings.
2. Redeploy.

Do not paste `.env.local` into source files and do not commit real tokens. The password protection is
provided by `ORCHESTRATOR_PASSWORD` or, for the Super Sauced routes only, `SUPER_SAUCED_PASSWORD`.

## Routes

All protected routes accept any of these forms:

```http
Authorization: Bearer <ORCHESTRATOR_PASSWORD>
x-orchestrator-password: <ORCHESTRATOR_PASSWORD>
Authorization: Basic <base64(username:password)>
```

### `GET /api/health`

Returns whether the required server-side configuration is present. It does not reveal secret values.

### `GET /api/projects`

Password-protected. Checks VerticalFlash project access and reads the configured Supabase workspace.

### `GET /api/super-sauced/media`

Password-protected. Lists the Super Sauced storage prefix and returns a VF-style folder projection:

```text
vf/
  Super Sauced/
    clips/
      raw-footage/
      proxies/
      thumbnails/
    filmcraft-projects/
    completed-videos/
```

### `POST /api/jobs`

Password-protected. Accepts a Grok edit-job payload and returns the normalized job envelope. This first
version validates and shapes the request; a render worker can later poll this route or a Supabase-backed
queue can be added once the exact job table contract is finalized.

Example:

```json
{
  "projectId": "79780694-67c4-4e98-9e58-49eb076bbc6e",
  "title": "Super Sauced vertical cut",
  "instructions": "Create a 30 second teaser from the strongest interview clips.",
  "sources": [
    {
      "storagePath": "79780694-67c4-4e98-9e58-49eb076bbc6e/uploads/example.mov"
    }
  ],
  "editPlan": {
    "format": "vertical-1080x1920",
    "durationSeconds": 30
  }
}
```

### `POST /api/publish`

Password-protected. Validates a completed video payload and reports the VerticalFlash connection status.
The final VerticalFlash "display this video to users" endpoint still needs to be confirmed before this
route can push the finished render into production display.
