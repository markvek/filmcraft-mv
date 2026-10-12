'use strict';

const { getConfig, configStatus } = require('./_lib/config');
const { methodAllowed, route, sendJson } = require('./_lib/http');

module.exports = route(async function health(req, res) {
  if (!methodAllowed(req, res, ['GET'])) {
    return;
  }

  const config = getConfig();
  sendJson(res, 200, {
    ok: true,
    service: 'filmcraft-grok-orchestrator',
    configured: configStatus(config)
  });
});
