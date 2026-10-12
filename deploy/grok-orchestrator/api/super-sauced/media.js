'use strict';

const { getConfig } = require('../_lib/config');
const { listStorageObjects } = require('../_lib/clients');
const { methodAllowed, requirePassword, route, sendJson } = require('../_lib/http');

function categorizeObject(object) {
  const name = String(object.name || '');
  const lower = name.toLowerCase();

  if (lower.includes('/proxies/') || lower.includes('proxy')) {
    return 'clips/proxies';
  }

  if (
    lower.includes('/thumbnails/') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.png') ||
    lower.endsWith('.webp')
  ) {
    return 'clips/thumbnails';
  }

  if (
    lower.endsWith('.mp4') ||
    lower.endsWith('.mov') ||
    lower.endsWith('.m4v') ||
    lower.endsWith('.webm')
  ) {
    return 'clips/raw-footage';
  }

  return 'clips/raw-footage';
}

function projectStoragePath(config) {
  return `${config.superSaucedWorkspaceId}/`;
}

module.exports = route(async function superSaucedMedia(req, res) {
  if (!methodAllowed(req, res, ['GET'])) {
    return;
  }

  const config = getConfig();
  requirePassword(req, config.superSaucedPassword || config.orchestratorPassword);

  const prefix = projectStoragePath(config);
  const objects = await listStorageObjects(config, config.supabaseMediaBucket, prefix);
  const files = Array.isArray(objects)
    ? objects.map((object) => ({
        name: object.name,
        bucket: config.supabaseMediaBucket,
        storagePath: `${prefix}${object.name}`,
        size: object.metadata && object.metadata.size ? object.metadata.size : null,
        updatedAt: object.updated_at || object.created_at || null,
        vfFolder: categorizeObject(object)
      }))
    : [];

  sendJson(res, 200, {
    ok: true,
    project: {
      name: config.superSaucedProjectName,
      workspaceId: config.superSaucedWorkspaceId
    },
    supabase: {
      bucket: config.supabaseMediaBucket,
      prefix
    },
    vfProjection: {
      root: 'vf',
      projectName: config.superSaucedProjectName,
      folders: {
        clips: ['raw-footage', 'proxies', 'thumbnails'],
        filmcraftProjects: [],
        completedVideos: []
      }
    },
    files
  });
});
