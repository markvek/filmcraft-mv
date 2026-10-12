#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FILMCRAFT_EDIT_OPERATION = '/api/filmcraft/edit';

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[match[1]]) {
      process.env[match[1]] = value;
    }
  }
}

function cleanEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function getConfig() {
  const repoRoot = path.resolve(__dirname, '../../..');
  loadDotEnv(path.resolve(repoRoot, '.env.local'));
  loadDotEnv(path.resolve(process.cwd(), '.env.local'));
  loadDotEnv(path.resolve(process.cwd(), 'deploy/grok-orchestrator/.env.local'));
  loadDotEnv(path.resolve(__dirname, '../.env.local'));

  const defaultCliPath = path.resolve(
    repoRoot,
    '.context/filmcraft-cli-release-0.6.0/filmcraft-cli-0.6.0-macos-universal/filmcraft-cli'
  );

  return {
    supabaseUrl: cleanEnv('NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/, ''),
    supabaseSecretKey: cleanEnv('SUPABASE_SECRET_KEY'),
    mediaBucket: cleanEnv('SUPABASE_MEDIA_BUCKET') || 'project-media',
    filmcraftCliPath: cleanEnv('FILMCRAFT_CLI_PATH') || defaultCliPath,
    workDir: cleanEnv('FILMCRAFT_WORK_DIR') || path.resolve(repoRoot, '.context/filmcraft-worker'),
    workerId: cleanEnv('FILMCRAFT_WORKER_ID') || `mac-${crypto.randomUUID()}`,
    renderFirstPass: cleanEnv('FILMCRAFT_WORKER_RENDER_FIRST_PASS') === 'true',
    once: process.argv.includes('--once'),
    dryRun: process.argv.includes('--dry-run'),
    intervalMs: Math.max(Number(cleanEnv('FILMCRAFT_WORKER_INTERVAL_MS')) || 5000, 1000),
    leaseSeconds: Math.max(Number(cleanEnv('FILMCRAFT_WORKER_LEASE_SECONDS')) || 900, 60)
  };
}

function requireConfig(config) {
  const missing = [];
  for (const [key, value] of Object.entries({
    NEXT_PUBLIC_SUPABASE_URL: config.supabaseUrl,
    SUPABASE_SECRET_KEY: config.supabaseSecretKey,
    FILMCRAFT_CLI_PATH: config.filmcraftCliPath
  })) {
    if (!value) {
      missing.push(key);
    }
  }

  if (!fs.existsSync(config.filmcraftCliPath)) {
    missing.push(`FILMCRAFT_CLI_PATH file not found: ${config.filmcraftCliPath}`);
  }

  if (missing.length > 0) {
    throw new Error(`Missing worker configuration: ${missing.join(', ')}`);
  }
}

function encodeStoragePath(storagePath) {
  return storagePath
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function sanitizeName(value) {
  return String(value || 'untitled')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

async function supabaseFetch(config, restPath, options = {}) {
  const response = await fetch(`${config.supabaseUrl}${restPath}`, {
    ...options,
    headers: {
      apikey: config.supabaseSecretKey,
      authorization: `Bearer ${config.supabaseSecretKey}`,
      ...(options.body && !options.skipJsonContentType ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_error) {
      body = text;
    }
  }

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  return body;
}

async function claimNextJob(config) {
  const now = new Date().toISOString();
  const query = [
    'operation=eq.' + encodeURIComponent(FILMCRAFT_EDIT_OPERATION),
    'status=eq.queued',
    'available_at=lte.' + encodeURIComponent(now),
    'order=created_at.asc',
    'limit=1',
    'select=*'
  ].join('&');
  const rows = await supabaseFetch(config, `/rest/v1/processing_jobs?${query}`);
  const job = Array.isArray(rows) ? rows[0] : null;

  if (!job) {
    return null;
  }

  const leaseToken = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + config.leaseSeconds * 1000).toISOString();
  const claimed = await supabaseFetch(
    config,
    `/rest/v1/processing_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.queued&select=*`,
    {
      method: 'PATCH',
      headers: {
        prefer: 'return=representation'
      },
      body: JSON.stringify({
        status: 'running',
        attempts: Number(job.attempts || 0) + 1,
        lease_token: leaseToken,
        lease_until: leaseUntil,
        phase: 'Claimed by FilmCraft Mac worker',
        phase_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    }
  );

  const row = Array.isArray(claimed) ? claimed[0] : null;
  return row ? { ...row, lease_token: leaseToken } : null;
}

async function updateJob(config, job, patch) {
  const rows = await supabaseFetch(
    config,
    `/rest/v1/processing_jobs?id=eq.${encodeURIComponent(job.id)}&select=*`,
    {
      method: 'PATCH',
      headers: {
        prefer: 'return=representation'
      },
      body: JSON.stringify({
        ...patch,
        updated_at: new Date().toISOString()
      })
    }
  );

  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function downloadStorageObject(config, bucket, storagePath, localPath) {
  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encodeStoragePath(storagePath)}`,
    {
      headers: {
        apikey: config.supabaseSecretKey,
        authorization: `Bearer ${config.supabaseSecretKey}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Download failed for ${storagePath}: ${response.status} ${await response.text()}`);
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, bytes);
}

async function uploadStorageObject(config, bucket, storagePath, localPath, contentType) {
  const bytes = fs.readFileSync(localPath);
  await supabaseFetch(
    config,
    `/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(storagePath)}`,
    {
      method: 'POST',
      skipJsonContentType: true,
      headers: {
        'content-type': contentType || 'application/octet-stream',
        'x-upsert': 'true'
      },
      body: bytes
    }
  );
}

function runFilmCraft(config, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.filmcraftCliPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`filmcraft-cli exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function normalizeSource(config, source) {
  const raw = source.storagePath || '';
  const bucketPrefix = `${config.mediaBucket}/`;
  const storagePath = raw.startsWith(bucketPrefix) ? raw.slice(bucketPrefix.length) : raw;
  const fileName = sanitizeName(source.label || path.basename(storagePath || source.url || 'source.mov'));

  return {
    ...source,
    storagePath,
    fileName
  };
}

async function prepareLocalProject(config, job) {
  const payload = job.input && job.input.body ? job.input.body : {};
  const outputs = job.input && job.input.outputs ? job.input.outputs : {};
  const projectName = payload.projectName || payload.projectId || job.workspace_id;
  const jobDir = path.join(config.workDir, 'vf', sanitizeName(projectName), 'filmcraft-projects', job.id);
  const clipsDir = path.join(jobDir, 'clips', 'raw-footage');
  const projectPath = path.join(jobDir, 'project.fcproj');
  const firstPassPath = path.join(jobDir, 'first-pass.mp4');
  const metadataPath = path.join(jobDir, 'metadata.json');
  const editPlanPath = path.join(jobDir, 'edit-plan.json');
  const sourcesPath = path.join(jobDir, 'sources.json');

  fs.mkdirSync(clipsDir, { recursive: true });
  fs.writeFileSync(editPlanPath, JSON.stringify(payload.editPlan || {}, null, 2));
  fs.writeFileSync(sourcesPath, JSON.stringify(payload.sources || [], null, 2));

  const downloaded = [];
  for (const source of payload.sources || []) {
    const normalized = normalizeSource(config, source);
    if (!normalized.storagePath) {
      continue;
    }
    const localPath = path.join(clipsDir, normalized.fileName);
    await downloadStorageObject(config, config.mediaBucket, normalized.storagePath, localPath);
    downloaded.push({
      ...normalized,
      localPath
    });
  }

  await runFilmCraft(
    config,
    [
      '--save-as',
      projectPath,
      'exec',
      'file.newSequence',
      `name=${JSON.stringify(payload.title || 'First Pass')}`,
      'width=1080',
      'height=1920',
      'fps=30',
      '--compact'
    ],
    jobDir
  );

  let importedItemIds = [];
  if (downloaded.length > 0) {
    const importOutput = await runFilmCraft(
      config,
      ['--project', projectPath, '--save', 'import', ...downloaded.map((source) => source.localPath), '--compact'],
      jobDir
    );
    const parsed = JSON.parse(importOutput);
    importedItemIds = Array.isArray(parsed.items) ? parsed.items : [];
  }

  if (importedItemIds.length > 0) {
    await runFilmCraft(
      config,
      [
        '--project',
        projectPath,
        '--save',
        'exec',
        'clip.automateToSequence',
        JSON.stringify({
          items: importedItemIds,
          ordering: 'selection',
          placement: 'sequentially',
          method: 'overwrite',
          videoTransition: false,
          audioTransition: false
        }),
        '--compact'
      ],
      jobDir
    );
  }

  let renderStatus = 'not-rendered';
  if (config.renderFirstPass && importedItemIds.length > 0) {
    await runFilmCraft(
      config,
      [
        '--project',
        projectPath,
        'export',
        firstPassPath,
        '--format',
        'h264',
        '--range',
        'entire',
        '--compact'
      ],
      jobDir
    );
    renderStatus = fs.existsSync(firstPassPath) ? 'rendered' : 'missing-output';
  } else if (!config.renderFirstPass) {
    renderStatus = 'skipped-by-config';
  }

  const metadata = {
    jobId: job.id,
    workspaceId: job.workspace_id,
    title: payload.title || null,
    instructions: payload.instructions || null,
    editableProjectPath: projectPath,
    firstPassPath,
    downloadedSources: downloaded.map((source) => ({
      storagePath: source.storagePath,
      localPath: source.localPath
    })),
    createdAt: new Date().toISOString(),
    renderStatus
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  if (!config.dryRun) {
    const bucket = outputs.bucket || config.mediaBucket;
    await uploadStorageObject(config, bucket, outputs.projectFile, projectPath, 'application/octet-stream');
    await uploadStorageObject(config, bucket, outputs.editPlan, editPlanPath, 'application/json');
    await uploadStorageObject(config, bucket, outputs.sources, sourcesPath, 'application/json');
    await uploadStorageObject(config, bucket, outputs.metadata, metadataPath, 'application/json');
    if (fs.existsSync(firstPassPath)) {
      await uploadStorageObject(config, bucket, outputs.firstPassVideo, firstPassPath, 'video/mp4');
    }
  }

  return {
    local: {
      jobDir,
      projectPath,
      editPlanPath,
      sourcesPath,
      metadataPath,
      firstPassPath
    },
    uploaded: config.dryRun
      ? null
      : {
          bucket: outputs.bucket || config.mediaBucket,
          projectFile: outputs.projectFile,
          editPlan: outputs.editPlan,
          sources: outputs.sources,
          firstPassVideo: fs.existsSync(firstPassPath) ? outputs.firstPassVideo : null,
          metadata: outputs.metadata
        },
    importedItemIds
  };
}

async function processJob(config, job) {
  await updateJob(config, job, {
    phase: 'Creating editable FilmCraft project',
    phase_updated_at: new Date().toISOString()
  });

  const result = await prepareLocalProject(config, job);

  await updateJob(config, job, {
    status: 'succeeded',
    phase: 'Editable FilmCraft project ready',
    phase_updated_at: new Date().toISOString(),
    result,
    response_status: 200,
    error: null,
    completed_token: crypto.randomUUID(),
    lease_token: null,
    lease_until: null
  });

  return result;
}

async function tick(config) {
  const job = await claimNextJob(config);
  if (!job) {
    console.log(`[${new Date().toISOString()}] no queued FilmCraft edit jobs`);
    return;
  }

  console.log(`[${new Date().toISOString()}] claimed ${job.id}`);
  try {
    const result = await processJob(config, job);
    console.log(`[${new Date().toISOString()}] completed ${job.id}`);
    console.log(JSON.stringify(result.local, null, 2));
  } catch (error) {
    await updateJob(config, job, {
      status: 'failed',
      phase: 'FilmCraft worker failed',
      phase_updated_at: new Date().toISOString(),
      error: error && error.stack ? error.stack : String(error),
      lease_token: null,
      lease_until: null
    });
    throw error;
  }
}

async function main() {
  const config = getConfig();
  requireConfig(config);
  fs.mkdirSync(config.workDir, { recursive: true });

  if (config.once) {
    await tick(config);
    return;
  }

  while (true) {
    await tick(config);
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
