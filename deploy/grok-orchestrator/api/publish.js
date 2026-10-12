'use strict';

const { getConfig } = require('./_lib/config');
const { verticalFlashFetch } = require('./_lib/clients');
const {
  HttpError,
  methodAllowed,
  readJsonBody,
  requirePassword,
  route,
  sendJson
} = require('./_lib/http');

module.exports = route(async function publish(req, res) {
  if (!methodAllowed(req, res, ['POST'])) {
    return;
  }

  const config = getConfig();
  requirePassword(req, config.orchestratorPassword);

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }

  const completedVideoPath =
    typeof body.completedVideoPath === 'string' ? body.completedVideoPath.trim() : '';
  if (!completedVideoPath) {
    throw new HttpError(400, 'completedVideoPath is required.');
  }

  const verticalFlash = await verticalFlashFetch(config, '/api/admin/jobs');

  sendJson(res, 501, {
    ok: false,
    readyForPublish: false,
    completedVideoPath,
    verticalFlash: {
      reachable: true,
      onlineProcessors: verticalFlash.online_processors,
      serverTime: verticalFlash.server_time
    },
    missing:
      'The VerticalFlash endpoint for attaching/displaying a completed video still needs to be confirmed.'
  });
});
