'use strict';

const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

function setCommonHeaders(res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', process.env.CORS_ALLOW_ORIGIN || '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'authorization,content-type,x-orchestrator-password'
  );
}

function sendJson(res, status, body) {
  setCommonHeaders(res);
  res.statusCode = status;
  res.end(JSON.stringify(body, null, 2));
}

function methodAllowed(req, res, methods) {
  if (req.method === 'OPTIONS') {
    setCommonHeaders(res);
    res.statusCode = 204;
    res.end();
    return false;
  }

  if (!methods.includes(req.method)) {
    sendJson(res, 405, {
      ok: false,
      error: `Method ${req.method} is not supported for this route.`,
      allowedMethods: methods
    });
    return false;
  }

  return true;
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(a || '', 'utf8');
  const right = Buffer.from(b || '', 'utf8');
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function getBearerPassword(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function getBasicPassword(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Basic\s+(.+)$/i);
  if (!match) {
    return '';
  }

  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator >= 0 ? decoded.slice(separator + 1) : '';
  } catch (_error) {
    return '';
  }
}

function requirePassword(req, expectedPassword) {
  if (!expectedPassword) {
    throw new HttpError(503, 'ORCHESTRATOR_PASSWORD is not configured.');
  }

  const headerPassword = req.headers['x-orchestrator-password'] || '';
  const candidate =
    getBearerPassword(req) ||
    (Array.isArray(headerPassword) ? headerPassword[0] : headerPassword) ||
    getBasicPassword(req);

  if (!timingSafeEqualText(String(candidate), expectedPassword)) {
    throw new HttpError(401, 'A valid orchestrator password is required.');
  }
}

function requestId(prefix) {
  const bytes = crypto.randomBytes(8).toString('hex');
  return `${prefix}-${Date.now().toString(36)}-${bytes}`;
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new HttpError(413, 'Request body is too large.');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch (_error) {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function route(handler) {
  return async function handle(req, res) {
    try {
      await handler(req, res);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      sendJson(res, status, {
        ok: false,
        error: status >= 500 ? 'The orchestrator request failed.' : error.message,
        details: status >= 500 ? undefined : error.details
      });
    }
  };
}

module.exports = {
  HttpError,
  methodAllowed,
  readJsonBody,
  requestId,
  requirePassword,
  route,
  sendJson
};
