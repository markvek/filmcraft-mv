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
2. Run `sql/filmcraft_edit_jobs.sql` in the Supabase SQL editor.
3. Redeploy.

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

Password-protected. Accepts a Grok edit-job payload, validates it, and writes a queued row to
`filmcraft_edit_jobs` in Supabase. The local Mac worker claims rows from this queue.

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

## Local Mac worker

The worker runs on your Mac and does the editing/rendering work. Vercel stays as the public control
plane; large video files do not pass through Vercel.

Build FilmCraft CLI first from the repo root:

```sh
cargo build --release -p filmcraft-cli
```

Run one polling pass manually:

```sh
ORCHESTRATOR_URL=https://filmcraft-mv-grok-orchestrator.vercel.app \
ORCHESTRATOR_PASSWORD='your-orchestrator-password' \
NEXT_PUBLIC_SUPABASE_URL='https://your-project.supabase.co' \
SUPABASE_SECRET_KEY='your-service-role-key' \
SUPABASE_MEDIA_BUCKET=project-media \
FILMCRAFT_CLI="$PWD/target/release/filmcraft-cli" \
node deploy/grok-orchestrator/scripts/mac-worker.js --once
```

Run continuously:

```sh
ORCHESTRATOR_PASSWORD='your-orchestrator-password' \
NEXT_PUBLIC_SUPABASE_URL='https://your-project.supabase.co' \
SUPABASE_SECRET_KEY='your-service-role-key' \
FILMCRAFT_CLI="$PWD/target/release/filmcraft-cli" \
node deploy/grok-orchestrator/scripts/mac-worker.js
```

The worker stores local editable projects and renders under:

```text
~/Movies/FilmCraft/Worker/jobs/<job-id>/
```

Each job folder contains the raw job JSON, downloaded sources, `project.fcproj`, `completed.mp4`, and
`worker.log`.

For automatic startup on macOS, copy
`launchd/com.filmcraft.grok-worker.plist.example` to:

```text
~/Library/LaunchAgents/com.filmcraft.grok-worker.plist
```

Edit the paths and secrets, then load it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.filmcraft.grok-worker.plist
launchctl enable gui/$(id -u)/com.filmcraft.grok-worker
launchctl kickstart -k gui/$(id -u)/com.filmcraft.grok-worker
```

### Worker API

These routes are password-protected with `ORCHESTRATOR_PASSWORD`:

| Route | Purpose |
| --- | --- |
| `POST /api/worker/next` | Claim the next queued job. |
| `POST /api/worker/status` | Update progress or failure status. |
| `POST /api/worker/source-url` | Create a short-lived signed URL for a Supabase source object. |
| `POST /api/worker/complete` | Mark a job complete after upload. |

The worker supports `editPlan.commands` for exact FilmCraft command recipes. Each step is:

```json
{
  "id": "file.import",
  "params": {
    "paths": ["$SOURCE_1"]
  }
}
```

Available tokens are `$SOURCE_1`, `$SOURCE_2`, `$PROJECT_PATH`, and `$OUTPUT_PATH`. Without
`editPlan.commands`, the worker makes a simple native FilmCraft project: import sources, create a
sequence from the first clip, place the remaining clips, apply default transitions where possible, export
`completed.mp4`, and upload it to `completed-videos/<job-id>/completed.mp4`.
