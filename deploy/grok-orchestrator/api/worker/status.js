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

const ALLOWED_STATUS = new Set([
  'claimed',
  'downloading',
  'editing',
  'rendering',
  'uploading',
  'completed',
  'failed'
]);

function cleanProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const pct = Number(value.pct);
  return {
    pct: Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : undefined,
    message: typeof value.message === 'string' ? value.message.slice(0, 500) : undefined,
    details: value.details && typeof value.details === 'object' ? value.details : undefined
  };
}

module.exports = route(async function workerStatus(req, res) {
  if (!methodAllowed(req, res, ['POST'])) {
    return;
  }

  const config = getConfig();
  requirePassword(req, config.orchestratorPassword);

  const body = await readJsonBody(req);
  const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : '';
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  if (!id) {
    throw new HttpError(400, 'id is required.');
  }
  if (!ALLOWED_STATUS.has(status)) {
    throw new HttpError(400, `status must be one of: ${Array.from(ALLOWED_STATUS).join(', ')}.`);
  }

  const now = new Date().toISOString();
  const update = {
    status,
    updated_at: now,
    progress: cleanProgress(body.progress)
  };
  if (status === 'failed') {
    update.error = typeof body.error === 'string' ? body.error.slice(0, 2000) : 'Worker failed.';
    update.finished_at = now;
  }

  const rows = await supabaseFetch(
    config,
    `/rest/v1/${encodeURIComponent(config.jobsTable)}?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify(update)
    }
  );

  sendJson(res, 200, {
    ok: true,
    job: Array.isArray(rows) ? rows[0] || null : null
  });
});
