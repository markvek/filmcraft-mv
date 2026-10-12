'use strict';

const { getConfig } = require('./_lib/config');
const { supabaseFetch, verticalFlashFetch } = require('./_lib/clients');
const { methodAllowed, requirePassword, route, sendJson } = require('./_lib/http');

function pickVerticalFlashProject(projects, name) {
  if (!Array.isArray(projects)) {
    return null;
  }

  return (
    projects.find((project) => {
      const projectName = String(project.name || project.title || '').toLowerCase();
      return projectName === String(name).toLowerCase();
    }) || null
  );
}

module.exports = route(async function projects(req, res) {
  if (!methodAllowed(req, res, ['GET'])) {
    return;
  }

  const config = getConfig();
  requirePassword(req, config.orchestratorPassword);

  const [verticalFlash, workspaceRows] = await Promise.all([
    verticalFlashFetch(config, '/api/admin/projects/'),
    supabaseFetch(
      config,
      `/rest/v1/workspaces?id=eq.${encodeURIComponent(
        config.superSaucedWorkspaceId
      )}&select=id,name,created_at,updated_at&limit=1`
    )
  ]);

  const verticalFlashProjects = Array.isArray(verticalFlash.projects) ? verticalFlash.projects : [];
  const superSaucedProject = pickVerticalFlashProject(
    verticalFlashProjects,
    config.superSaucedProjectName
  );

  sendJson(res, 200, {
    ok: true,
    superSauced: {
      workspaceId: config.superSaucedWorkspaceId,
      projectName: config.superSaucedProjectName,
      workspace: Array.isArray(workspaceRows) ? workspaceRows[0] || null : null,
      verticalFlashProject: superSaucedProject
    },
    verticalFlash: {
      projectCount: verticalFlashProjects.length,
      onlineProcessors: verticalFlash.online_processors,
      serverTime: verticalFlash.server_time
    }
  });
});
