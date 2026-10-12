#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const CONFIG = {
  orchestratorUrl:
    process.env.ORCHESTRATOR_URL || 'https://filmcraft-mv-grok-orchestrator.vercel.app',
  password: process.env.ORCHESTRATOR_PASSWORD || '',
  workerId: process.env.WORKER_ID || `${os.hostname()}-${process.pid}`,
  root: expandHome(process.env.FILMCRAFT_WORKER_ROOT || '~/Movies/FilmCraft/Worker'),
  filmcraftCli: process.env.FILMCRAFT_CLI || './target/release/filmcraft-cli',
  pollSeconds: clampInt(process.env.WORKER_POLL_SECONDS, 15, 5, 300),
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SECRET_KEY || '',
  mediaBucket: process.env.SUPABASE_MEDIA_BUCKET || 'project-media'
};

function expandHome(value) {
  if (!value || value === '~') {
    return os.homedir();
  }
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function safeName(value, fallback) {
  const name = String(value || fallback || 'file')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return name || fallback || 'file';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendLog(file, message) {
  await fsp.appendFile(file, `${new Date().toISOString()} ${message}\n`);
}

async function api(endpoint, body) {
  const response = await fetch(`${CONFIG.orchestratorUrl.replace(/\/+$/, '')}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-orchestrator-password': CONFIG.password
    },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_error) {
      parsed = { raw: text };
    }
  }
  if (!response.ok || (parsed && parsed.ok === false)) {
    const error = parsed && parsed.error ? parsed.error : `HTTP ${response.status}`;
    throw new Error(`${endpoint}: ${error}`);
  }
  return parsed || {};
}

async function updateStatus(job, status, pct, message, extra) {
  await api('/api/worker/status', {
    id: job.id,
    status,
    progress: {
      pct,
      message,
      details: extra || undefined
    }
  });
}

async function downloadFile(url, target) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target));
}

async function sourceUrl(source) {
  if (source.url) {
    return source.url;
  }
  if (!source.storagePath) {
    throw new Error('source needs either url or storagePath');
  }
  const signed = await api('/api/worker/source-url', {
    storagePath: source.storagePath,
    expiresIn: 3600
  });
  return signed.signedUrl;
}

async function downloadSources(job, jobDir, logFile) {
  const sourceDir = path.join(jobDir, 'sources');
  await fsp.mkdir(sourceDir, { recursive: true });
  const downloaded = [];

  for (let index = 0; index < job.sources.length; index += 1) {
    const source = job.sources[index];
    const srcUrl = await sourceUrl(source);
    const fromPath = source.storagePath || new URL(srcUrl).pathname;
    const ext = path.extname(fromPath) || '.mov';
    const label = source.label || path.basename(fromPath, ext) || `source-${index + 1}`;
    const target = path.join(sourceDir, `${String(index + 1).padStart(2, '0')}-${safeName(label)}${ext}`);
    await appendLog(logFile, `downloading ${fromPath} -> ${target}`);
    await downloadFile(srcUrl, target);
    downloaded.push({
      ...source,
      localPath: target
    });
  }

  await fsp.writeFile(path.join(jobDir, 'downloaded-sources.json'), JSON.stringify(downloaded, null, 2));
  return downloaded;
}

function parseJsonOutput(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch (_ignored) {
        // Keep scanning for the last JSON line.
      }
    }
  }
  return null;
}

async function runCli(args, logFile) {
  await appendLog(logFile, `filmcraft-cli ${args.join(' ')}`);
  const result = spawnSync(CONFIG.filmcraftCli, args, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
  if (result.stdout) {
    await appendLog(logFile, `stdout: ${result.stdout.trim()}`);
  }
  if (result.stderr) {
    await appendLog(logFile, `stderr: ${result.stderr.trim()}`);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`filmcraft-cli exited ${result.status}`);
  }
  return parseJsonOutput(result.stdout);
}

async function execCommand(projectPath, command, params, logFile) {
  const args = ['--project', projectPath, '--save', 'exec', command, JSON.stringify(params || {})];
  return runCli(args, logFile);
}

async function createProject(projectPath, title, logFile) {
  return runCli(
    ['--save-as', projectPath, 'exec', 'file.newProject', JSON.stringify({ name: title })],
    logFile
  );
}

function replaceTokens(value, tokens) {
  if (typeof value === 'string') {
    let next = value;
    for (const [key, tokenValue] of Object.entries(tokens)) {
      next = next.replaceAll(`$${key}`, tokenValue).replaceAll(`\${${key}}`, tokenValue);
    }
    return next;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceTokens(item, tokens));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceTokens(item, tokens)])
    );
  }
  return value;
}

async function runCommandRecipe(job, projectPath, outputPath, downloaded, logFile) {
  await createProject(projectPath, job.title, logFile);
  const tokens = {
    PROJECT_PATH: projectPath,
    OUTPUT_PATH: outputPath
  };
  downloaded.forEach((source, index) => {
    tokens[`SOURCE_${index + 1}`] = source.localPath;
  });

  for (const step of job.editPlan.commands) {
    if (!step || typeof step !== 'object' || typeof step.id !== 'string') {
      throw new Error('editPlan.commands entries must be objects with an id');
    }
    await execCommand(projectPath, step.id, replaceTokens(step.params || {}, tokens), logFile);
  }
}

function collectClipIds(value, ids) {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectClipIds(item, ids));
    return;
  }
  if (Number.isInteger(value.id) && value.sourceIn !== undefined) {
    ids.add(value.id);
  }
  for (const item of Object.values(value)) {
    collectClipIds(item, ids);
  }
}

async function runSimpleEdit(job, projectPath, outputPath, downloaded, logFile) {
  if (downloaded.length === 0) {
    throw new Error('job has no sources to edit');
  }

  await createProject(projectPath, job.title, logFile);
  const imported = await execCommand(
    projectPath,
    'file.import',
    { paths: downloaded.map((source) => source.localPath) },
    logFile
  );
  const itemIds = imported && Array.isArray(imported.items) ? imported.items : [];
  if (itemIds.length === 0) {
    throw new Error('FilmCraft did not import any media items');
  }

  await execCommand(projectPath, 'file.newSequenceFromClip', { items: [itemIds[0]] }, logFile);
  for (let index = 1; index < itemIds.length; index += 1) {
    await execCommand(
      projectPath,
      'timeline.place',
      {
        item: itemIds[index],
        track: 'V1',
        audioTrack: 'A1',
        seconds: index * 6
      },
      logFile
    );
  }

  const sequence = await runCli(['--project', projectPath, 'inspect', 'sequence'], logFile);
  const clipIds = new Set();
  collectClipIds(sequence, clipIds);
  if (clipIds.size > 0) {
    try {
      await execCommand(
        projectPath,
        'sequence.applyDefaultTransitionsToSelection',
        { clips: Array.from(clipIds) },
        logFile
      );
    } catch (error) {
      await appendLog(logFile, `default transitions skipped: ${error.message}`);
    }
  }

  await execCommand(
    projectPath,
    'file.exportMedia',
    {
      path: outputPath,
      format: 'h264',
      range: 'custom',
      startSeconds: 0,
      endSeconds:
        Number.isFinite(Number(job.editPlan && job.editPlan.durationSeconds))
          ? Math.min(Math.max(Number(job.editPlan.durationSeconds), 1), 60 * 60)
          : 20,
      wait: true
    },
    logFile
  );
}

async function uploadCompletedVideo(job, filePath, logFile) {
  const storagePath = `completed-videos/${job.id}/completed.mp4`;
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
    await appendLog(logFile, 'Supabase upload skipped: SUPABASE_URL and SUPABASE_SECRET_KEY are not set');
    return `local://${filePath}`;
  }

  const stat = await fsp.stat(filePath);
  const response = await fetch(
    `${CONFIG.supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/${encodeURIComponent(
      CONFIG.mediaBucket
    )}/${storagePath}`,
    {
      method: 'POST',
      headers: {
        apikey: CONFIG.supabaseKey,
        authorization: `Bearer ${CONFIG.supabaseKey}`,
        'content-type': 'video/mp4',
        'content-length': String(stat.size),
        'x-upsert': 'true'
      },
      body: fs.createReadStream(filePath),
      duplex: 'half'
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase upload failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return storagePath;
}

async function processJob(job) {
  const jobDir = path.join(CONFIG.root, 'jobs', safeName(job.id));
  const logFile = path.join(jobDir, 'worker.log');
  const projectPath = path.join(jobDir, 'project.fcproj');
  const outputPath = path.join(jobDir, 'completed.mp4');
  await fsp.mkdir(jobDir, { recursive: true });
  await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(job, null, 2));

  try {
    await updateStatus(job, 'downloading', 10, 'Downloading source footage.');
    const downloaded = await downloadSources(job, jobDir, logFile);

    await updateStatus(job, 'editing', 35, 'Building editable FilmCraft project.');
    if (job.editPlan && Array.isArray(job.editPlan.commands) && job.editPlan.commands.length > 0) {
      await runCommandRecipe(job, projectPath, outputPath, downloaded, logFile);
    } else {
      await runSimpleEdit(job, projectPath, outputPath, downloaded, logFile);
    }

    await updateStatus(job, 'uploading', 90, 'Uploading completed video.');
    const completedVideoPath = await uploadCompletedVideo(job, outputPath, logFile);
    const complete = await api('/api/worker/complete', {
      id: job.id,
      completedVideoPath,
      localProjectPath: projectPath,
      localRenderPath: outputPath
    });
    await appendLog(logFile, `completed: ${JSON.stringify(complete)}`);
  } catch (error) {
    await appendLog(logFile, `failed: ${error.stack || error.message}`);
    try {
      await api('/api/worker/status', {
        id: job.id,
        status: 'failed',
        error: error.message,
        progress: {
          pct: 100,
          message: 'Worker failed.',
          details: {
            localProjectPath: projectPath,
            localRenderPath: outputPath
          }
        }
      });
    } catch (statusError) {
      await appendLog(logFile, `failed to report worker failure: ${statusError.message}`);
    }
  }
}

async function pollOnce() {
  const next = await api('/api/worker/next', {
    workerId: CONFIG.workerId
  });
  if (!next.job) {
    return false;
  }
  await processJob(next.job);
  return true;
}

async function main() {
  if (!CONFIG.password) {
    throw new Error('ORCHESTRATOR_PASSWORD is required');
  }
  await fsp.mkdir(path.join(CONFIG.root, 'jobs'), { recursive: true });

  const once = process.argv.includes('--once');
  do {
    let didWork = false;
    try {
      didWork = await pollOnce();
    } catch (error) {
      console.error(error.stack || error.message);
    }
    if (once) {
      break;
    }
    await sleep((didWork ? 1 : CONFIG.pollSeconds) * 1000);
  } while (true);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
