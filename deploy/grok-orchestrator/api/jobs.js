'use strict';

const { getConfig } = require('./_lib/config');
const { supabaseFetch } = require('./_lib/clients');
const {
  HttpError,
  methodAllowed,
  readJsonBody,
  requestId,
  requirePassword,
  route,
  sendJson
} = require('./_lib/http');

function asNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeSources(value) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new HttpError(400, 'sources must be an array when provided.');
  }

  return value.slice(0, 200).map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new HttpError(400, `sources[${index}] must be an object.`);
    }

    return {
      storagePath:
        typeof source.storagePath === 'string' && source.storagePath.trim()
          ? source.storagePath.trim()
          : null,
      url: typeof source.url === 'string' && source.url.trim() ? source.url.trim() : null,
      label: typeof source.label === 'string' && source.label.trim() ? source.label.trim() : null
    };
  });
}

async function persistJob(config, job) {
  const rows = await supabaseFetch(config, `/rest/v1/${encodeURIComponent(config.jobsTable)}`, {
    method: 'POST',
    headers: {
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      id: job.id,
      status: 'queued',
      project_id: job.projectId,
      title: job.title,
      instructions: job.instructions,
      sources: job.sources,
      edit_plan: job.editPlan,
      created_at: job.createdAt,
      updated_at: job.createdAt
    })
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

module.exports = route(async function jobs(req, res) {
  if (!methodAllowed(req, res, ['POST'])) {
    return;
  }

  const config = getConfig();
  requirePassword(req, config.orchestratorPassword);

  const body = await readJsonBody(req);
  const title = asNonEmptyString(body.title || body.name, 'title');
  const instructions = asNonEmptyString(body.instructions || body.prompt, 'instructions');
  const projectId =
    typeof body.projectId === 'string' && body.projectId.trim()
      ? body.projectId.trim()
      : config.superSaucedWorkspaceId;
  const sources = normalizeSources(body.sources);

  if (body.editPlan !== undefined && (typeof body.editPlan !== 'object' || Array.isArray(body.editPlan))) {
    throw new HttpError(400, 'editPlan must be an object when provided.');
  }

  const job = {
    id: requestId('edit'),
    status: 'queued',
    projectId,
    title,
    instructions,
    sources,
    editPlan: body.editPlan || {},
    nextAction:
      'Queue this job for a FilmCraft worker, then upload the rendered output to Supabase completed-videos.',
    createdAt: new Date().toISOString()
  };
  const persistedJob = await persistJob(config, job);

  sendJson(res, 202, {
    ok: true,
    persisted: true,
    job,
    queueRow: persistedJob
  });
});
