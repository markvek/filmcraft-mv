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

async function createSignedStorageUrl(config, bucket, objectPath, expiresIn = 3600) {
  requireConfigValue(config.supabaseUrl, 'NEXT_PUBLIC_SUPABASE_URL');
  requireConfigValue(config.supabaseSecretKey, 'SUPABASE_SECRET_KEY');

  const safeExpiresIn = Math.min(Math.max(Number(expiresIn) || 3600, 60), 24 * 60 * 60);
  const pathParts = String(objectPath || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const result = await supabaseFetch(
    config,
    `/storage/v1/object/sign/${encodeURIComponent(bucket)}/${pathParts}`,
    {
      method: 'POST',
      body: JSON.stringify({ expiresIn: safeExpiresIn })
    }
  );

  const signedPath = result && (result.signedURL || result.signedUrl);
  if (typeof signedPath !== 'string' || !signedPath) {
    throw new HttpError(502, 'Supabase did not return a signed URL.');
  }

  return signedPath.startsWith('http')
    ? signedPath
    : `${config.supabaseUrl.replace(/\/+$/, '')}/storage/v1${signedPath}`;
}

module.exports = {
  createSignedStorageUrl,
  listStorageObjects,
  supabaseFetch,
  verticalFlashFetch
};
