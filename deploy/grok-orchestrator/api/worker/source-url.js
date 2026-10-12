'use strict';

const { getConfig } = require('../_lib/config');
const { createSignedStorageUrl } = require('../_lib/clients');
const {
  HttpError,
  methodAllowed,
  readJsonBody,
  requirePassword,
  route,
  sendJson
} = require('../_lib/http');

module.exports = route(async function sourceUrl(req, res) {
  if (!methodAllowed(req, res, ['POST'])) {
    return;
  }

  const config = getConfig();
  requirePassword(req, config.orchestratorPassword);

  const body = await readJsonBody(req);
  const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : '';
  if (!storagePath || storagePath.includes('..')) {
    throw new HttpError(400, 'storagePath must be a non-empty Supabase storage object path.');
  }

  const bucket =
    typeof body.bucket === 'string' && body.bucket.trim()
      ? body.bucket.trim()
      : config.supabaseMediaBucket;
  const expiresIn = Number.isFinite(Number(body.expiresIn)) ? Number(body.expiresIn) : 3600;
  const signedUrl = await createSignedStorageUrl(config, bucket, storagePath, expiresIn);

  sendJson(res, 200, {
    ok: true,
    bucket,
    storagePath,
    signedUrl,
    expiresIn: Math.min(Math.max(expiresIn || 3600, 60), 24 * 60 * 60)
  });
});
