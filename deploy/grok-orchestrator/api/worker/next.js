'use strict';

const { getConfig } = require('../_lib/config');
const { supabaseFetch } = require('../_lib/clients');
const {
  HttpError,
  methodAllowed,
  readJsonBody,
  requirePassword,
  route,
  sendJson
} = require('../_lib/http');

function rowToJob(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    projectId: row.project_id,
    title: row.title,
    instructions: row.instructions,
    sources: Array.isArray(row.sources) ? row.sources : [],
    editPlan: row.edit_plan && typeof row.edit_plan === 'object' ? row.edit_plan : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    row
  };
}

module.exports = route(async function nextJob(req, res) {
  if (!methodAllowed(req, res, ['POST'])) {
    return;
  }

  const config = getConfig();
  requirePassword(req, config.orchestratorPassword);

  const body = await readJsonBody(req);
  const workerId = typeof body.workerId === 'string' && body.workerId.trim() ? body.workerId.trim() : '';
  if (!workerId) {
    throw new HttpError(400, 'workerId is required.');
  }

  const table = encodeURIComponent(config.jobsTable);
  const rows = await supabaseFetch(
    config,
    `/rest/v1/${table}?status=eq.queued&select=*&order=created_at.asc&limit=1`
  );
  const next = Array.isArray(rows) ? rows[0] || null : null;
  if (!next) {
    sendJson(res, 200, {
      ok: true,
      job: null
    });
    return;
  }

  const now = new Date().toISOString();
  const claimedRows = await supabaseFetch(
    config,
    `/rest/v1/${table}?id=eq.${encodeURIComponent(next.id)}&status=eq.queued`,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        status: 'claimed',
        claimed_by: workerId,
        claimed_at: now,
        updated_at: now,
        progress: {
          pct: 0,
          message: 'Claimed by FilmCraft Mac worker.'
        }
      })
    }
  );
  const claimed = Array.isArray(claimedRows) ? claimedRows[0] || null : null;
  if (!claimed) {
    sendJson(res, 409, {
      ok: false,
      error: 'The queued job was already claimed. Retry /api/worker/next.'
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    job: rowToJob(claimed)
  });
});
