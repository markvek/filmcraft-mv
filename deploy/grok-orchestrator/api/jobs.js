'use strict';

const { getConfig } = require('./_lib/config');
const { createProcessingJob, findProcessingJobRequester, readProcessingJob } = require('./_lib/clients');
const {
  HttpError,
  methodAllowed,
  readJsonBody,
  requestId,
  requirePassword,
  route,
  sendJson
} = require('./_lib/http');

const FILMCRAFT_EDIT_OPERATION = '/api/filmcraft/edit';

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

module.exports = route(async function jobs(req, res) {
  if (!methodAllowed(req, res, ['GET', 'POST'])) {
    return;
  }

  const config = getConfig();
  requirePassword(req, config.orchestratorPassword);

  if (req.method === 'GET') {
    const url = new URL(req.url || '/api/jobs', 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) {
      throw new HttpError(400, 'id query parameter is required.');
    }

    const job = await readProcessingJob(config, id);
    if (!job) {
      throw new HttpError(404, 'Job was not found.');
    }

    sendJson(res, 200, {
      ok: true,
      job
    });
    return;
  }

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

  const idempotencyKey =
    typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : requestId('filmcraft-edit');
  const projectName =
    typeof body.projectName === 'string' && body.projectName.trim()
      ? body.projectName.trim()
      : config.superSaucedProjectName;
  const createdAt = new Date().toISOString();
  const outputBase = `${projectId}/filmcraft-projects/${idempotencyKey}`;
  const requestedBy =
    (typeof body.requestedBy === 'string' && body.requestedBy.trim()) ||
    config.processingJobRequestedBy ||
    (await findProcessingJobRequester(config, projectId));
  if (!requestedBy) {
    throw new HttpError(
      400,
      'No requested_by user could be resolved for this workspace. Set PROCESSING_JOB_REQUESTED_BY or pass requestedBy.'
    );
  }
  const input = {
    version: 1,
    kind: 'filmcraft-edit',
    body: {
      projectId,
      projectName,
      title,
      instructions,
      sources,
      editPlan: body.editPlan || {}
    },
    outputs: {
      bucket: config.supabaseMediaBucket,
      projectFile: `${outputBase}/project.fcproj`,
      editPlan: `${outputBase}/edit-plan.json`,
      sources: `${outputBase}/sources.json`,
      firstPassVideo: `${outputBase}/first-pass.mp4`,
      metadata: `${outputBase}/metadata.json`
    },
    createdAt
  };
  const row = await createProcessingJob(config, {
    workspace_id: projectId,
    requested_by: requestedBy,
    operation: FILMCRAFT_EDIT_OPERATION,
    input,
    expected_revision: Number.isInteger(body.expectedRevision) ? body.expectedRevision : 0,
    idempotency_key: idempotencyKey,
    status: 'queued',
    attempts: 0,
    phase: 'Queued for FilmCraft Mac worker',
    available_at: createdAt
  });

  sendJson(res, 202, {
    ok: true,
    persisted: true,
    job: row,
    worker: {
      operation: FILMCRAFT_EDIT_OPERATION,
      expectedOutput: input.outputs,
      nextAction: 'Run the local Mac worker to lease this job and create the editable FilmCraft project.'
    }
  });
});
