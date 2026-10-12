'use strict';

const DEFAULT_SUPER_SAUCED_WORKSPACE_ID = '79780694-67c4-4e98-9e58-49eb076bbc6e';

function cleanEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function getConfig() {
  return {
    supabaseUrl: cleanEnv('NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/, ''),
    supabaseSecretKey: cleanEnv('SUPABASE_SECRET_KEY'),
    verticalFlashUrl: cleanEnv('VERTICALFLASH_URL').replace(/\/+$/, ''),
    verticalFlashToken: cleanEnv('VERTICALFLASH_TOKEN'),
    orchestratorPassword: cleanEnv('ORCHESTRATOR_PASSWORD'),
    superSaucedPassword: cleanEnv('SUPER_SAUCED_PASSWORD'),
    superSaucedWorkspaceId:
      cleanEnv('SUPER_SAUCED_WORKSPACE_ID') || DEFAULT_SUPER_SAUCED_WORKSPACE_ID,
    superSaucedProjectName: cleanEnv('SUPER_SAUCED_PROJECT_NAME') || 'Super Sauced',
    supabaseMediaBucket: cleanEnv('SUPABASE_MEDIA_BUCKET') || 'project-media'
  };
}

function configStatus(config) {
  return {
    supabaseUrl: Boolean(config.supabaseUrl),
    supabaseSecretKey: Boolean(config.supabaseSecretKey),
    verticalFlashUrl: Boolean(config.verticalFlashUrl),
    verticalFlashToken: Boolean(config.verticalFlashToken),
    orchestratorPassword: Boolean(config.orchestratorPassword),
    superSaucedPassword: Boolean(config.superSaucedPassword),
    supabaseMediaBucket: config.supabaseMediaBucket,
    superSaucedWorkspaceId: config.superSaucedWorkspaceId,
    superSaucedProjectName: config.superSaucedProjectName
  };
}

module.exports = {
  DEFAULT_SUPER_SAUCED_WORKSPACE_ID,
  getConfig,
  configStatus
};
