#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { FINAL_SIGNOFF_ROLES, REQUIRED_LAUNCH_AREAS } from './production-launch-evidence.mjs';

const placeholderTimestamp = 'REPLACE_WITH_ISO_TIMESTAMP';

function evidenceTemplate() {
  return {
    version: 1,
    preparedBy: 'REPLACE_WITH_RELEASE_OWNER',
    preparedAt: placeholderTimestamp,
    approvedForLaunch: false,
    release: {
      commitSha: 'REPLACE_WITH_40_CHARACTER_GIT_SHA',
      workflowRunUrl: 'REPLACE_WITH_GITHUB_ACTIONS_RELEASE_WORKFLOW_RUN_URL',
      workflowFile: '.github/workflows/release-images.yml',
      gitRef: 'REPLACE_WITH_RELEASE_GIT_REF',
      imageDigestManifest: {
        apiImage: 'REPLACE_WITH_GHCR_API_IMAGE_SHA256_DIGEST',
        webImage: 'REPLACE_WITH_GHCR_WEB_IMAGE_SHA256_DIGEST',
        migrationImage: 'REPLACE_WITH_GHCR_MIGRATION_IMAGE_SHA256_DIGEST',
        webBuildNextPublicApiUrl: 'REPLACE_WITH_PRODUCTION_API_HTTPS_ORIGIN',
        webBuildNextPublicSupabaseUrl: 'REPLACE_WITH_PRODUCTION_SUPABASE_HTTPS_ORIGIN',
      },
    },
    areas: Object.fromEntries(REQUIRED_LAUNCH_AREAS.map((area) => [
      area.id,
      {
        owner: 'REPLACE_WITH_OWNER',
        status: 'pending',
        checks: Object.fromEntries(area.checks.map((check) => [
          check.id,
          {
            status: 'pending',
            evidence: [],
          },
        ])),
      },
    ])),
    finalSignoff: {
      status: 'pending',
      owner: 'REPLACE_WITH_ACCOUNTABLE_OWNER',
      approvedAt: placeholderTimestamp,
      approvals: Object.fromEntries(FINAL_SIGNOFF_ROLES.map((role) => [
        role.id,
        {
          status: 'pending',
          owner: `REPLACE_WITH_${role.id.toUpperCase()}_OWNER`,
          approvedAt: placeholderTimestamp,
          evidence: [],
        },
      ])),
      evidence: [],
    },
  };
}

export function renderProductionLaunchEvidenceTemplate() {
  return `${JSON.stringify(evidenceTemplate(), null, 2)}\n`;
}

function main() {
  process.stdout.write(renderProductionLaunchEvidenceTemplate());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
