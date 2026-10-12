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

### `GET /api/jobs?id=<job-id>`

Password-protected. Reads a Supabase `processing_jobs` row by id so Grok can check whether the local
Mac worker has finished.

### `POST /api/jobs`

Password-protected. Accepts a Grok edit-job payload, writes a durable Supabase `processing_jobs` row with
`operation = /api/filmcraft/edit`, and returns the queued job. The local Mac worker leases these jobs and
creates an editable FilmCraft project.

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

The worker writes artifacts to this Supabase storage layout:

```text
<workspace-id>/filmcraft-projects/<edit-job-id-or-idempotency-key>/
  project.fcproj
  edit-plan.json
  sources.json
  first-pass.mp4
  metadata.json
```

## Local Mac Worker

The Mac worker is what actually runs FilmCraft. Vercel should stay lightweight: it receives Grok's job,
writes the queue row, and returns quickly.

From the repository root:

```sh
npm --prefix deploy/grok-orchestrator run worker -- --once
```

Use `--once` to process one queued job and exit. Omit `--once` to keep polling:

```sh
npm --prefix deploy/grok-orchestrator run worker
```

For a safe local test that creates the editable project but does not upload artifacts:

```sh
npm --prefix deploy/grok-orchestrator run worker -- --once --dry-run
```

Worker-only environment variables:

```text
FILMCRAFT_CLI_PATH=/absolute/path/to/filmcraft-cli
FILMCRAFT_WORK_DIR=/Users/you/FilmCraftWorker
FILMCRAFT_WORKER_RENDER_FIRST_PASS=false
```

Set `FILMCRAFT_WORKER_RENDER_FIRST_PASS=true` when you want the worker to export `first-pass.mp4` after
it builds the editable project. Leave it off when you only want the `.fcproj` handoff for manual editing.

### `POST /api/publish`

Password-protected. Validates a completed video payload and reports the VerticalFlash connection status.
The final VerticalFlash "display this video to users" endpoint still needs to be confirmed before this
route can push the finished render into production display.
