'use strict';

const { getConfig } = require('../_lib/config');
const { supabaseFetch, verticalFlashFetch } = require('../_lib/clients');
const {
  HttpError,
  methodAllowed,
  readJsonBody,
  requirePassword,
  route,
  sendJson
} = require('../_lib/http');

module.exports = route(async function workerComplete(req, res) {
  if (!methodAllowed(req, res, ['POST'])) {
    return;
  }

  const config = getConfig();
  requirePassword(req, config.orchestratorPassword);

  const body = await readJsonBody(req);
  const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : '';
  const completedVideoPath =
    typeof body.completedVideoPath === 'string' && body.completedVideoPath.trim()
      ? body.completedVideoPath.trim()
      : '';
  if (!id) {
    throw new HttpError(400, 'id is required.');
  }
  if (!completedVideoPath) {
    throw new HttpError(400, 'completedVideoPath is required.');
  }

  const now = new Date().toISOString();
  const result = {
    completedVideoPath,
    localProjectPath:
      typeof body.localProjectPath === 'string' && body.localProjectPath.trim()
        ? body.localProjectPath.trim()
        : null,
    localRenderPath:
      typeof body.localRenderPath === 'string' && body.localRenderPath.trim()
        ? body.localRenderPath.trim()
        : null,
    completedAt: now
  };

  let verticalFlash = null;
  try {
    verticalFlash = await verticalFlashFetch(config, '/api/admin/jobs');
  } catch (error) {
    verticalFlash = {
      reachable: false,
      error: error.message
    };
  }

  const rows = await supabaseFetch(
    config,
    `/rest/v1/${encodeURIComponent(config.jobsTable)}?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        status: 'completed',
        result,
        updated_at: now,
        finished_at: now,
        progress: {
          pct: 100,
          message: 'Completed video uploaded.'
        }
      })
    }
  );

  sendJson(res, 200, {
    ok: true,
    job: Array.isArray(rows) ? rows[0] || null : null,
    verticalFlash: {
      publishEndpointConfirmed: false,
      probe: verticalFlash
    },
    note:
      'The completed video is recorded. The exact VerticalFlash endpoint for displaying it still needs to be wired.'
  });
});
