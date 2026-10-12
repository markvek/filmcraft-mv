'use strict';

const { HttpError } = require('./http');

function requireConfigValue(value, name) {
  if (!value) {
    throw new HttpError(503, `${name} is not configured.`);
  }
}

async function readJsonResponse(response, serviceName) {
  const text = await response.text();
  let parsed = null;

  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_error) {
      parsed = { raw: text.slice(0, 500) };
    }
  }

  if (!response.ok) {
    throw new HttpError(response.status, `${serviceName} returned ${response.status}.`, parsed);
  }

  return parsed;
}

async function supabaseFetch(config, path, options = {}) {
  requireConfigValue(config.supabaseUrl, 'NEXT_PUBLIC_SUPABASE_URL');
  requireConfigValue(config.supabaseSecretKey, 'SUPABASE_SECRET_KEY');

  const response = await fetch(`${config.supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: config.supabaseSecretKey,
      authorization: `Bearer ${config.supabaseSecretKey}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  return readJsonResponse(response, 'Supabase');
}

async function createProcessingJob(config, job) {
  const rows = await supabaseFetch(config, '/rest/v1/processing_jobs?select=*', {
    method: 'POST',
    headers: {
      prefer: 'return=representation'
    },
    body: JSON.stringify(job)
  });

  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function readProcessingJob(config, id) {
  const rows = await supabaseFetch(
    config,
    `/rest/v1/processing_jobs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );

  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function findProcessingJobRequester(config, workspaceId) {
  const rows = await supabaseFetch(
    config,
    `/rest/v1/processing_jobs?workspace_id=eq.${encodeURIComponent(
      workspaceId
    )}&requested_by=not.is.null&select=requested_by&order=created_at.desc&limit=1`
  );

  const row = Array.isArray(rows) ? rows[0] : null;
  return row && typeof row.requested_by === 'string' ? row.requested_by : '';
}

async function verticalFlashFetch(config, path, options = {}) {
  requireConfigValue(config.verticalFlashUrl, 'VERTICALFLASH_URL');
  requireConfigValue(config.verticalFlashToken, 'VERTICALFLASH_TOKEN');

  const response = await fetch(`${config.verticalFlashUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${config.verticalFlashToken}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  return readJsonResponse(response, 'VerticalFlash');
}

async function listStorageObjects(config, bucket, prefix, limit = 1000) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  return supabaseFetch(config, `/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
    method: 'POST',
    body: JSON.stringify({
      prefix,
      limit: safeLimit,
      offset: 0,
      sortBy: {
        column: 'name',
        order: 'asc'
      }
    })
  });
}

module.exports = {
  createProcessingJob,
  findProcessingJobRequester,
  listStorageObjects,
  readProcessingJob,
  supabaseFetch,
  verticalFlashFetch
};
