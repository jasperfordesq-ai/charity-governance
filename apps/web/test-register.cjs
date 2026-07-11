const Module = require('node:module');
const { resolve } = require('node:path');

// The web unit project emits CommonJS while the shared workspace deliberately
// publishes ESM only. Tests run with the tsx preload, so resolve this one
// workspace import to its TypeScript source instead of weakening the production
// package export contract with a fake CommonJS build.
const sharedSource = resolve(__dirname, '..', '..', 'packages', 'shared', 'src', 'index.ts');
const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveWebTestWorkspaceImport(request, parent, isMain, options) {
  if (request === '@charitypilot/shared') return sharedSource;
  return resolveFilename.call(this, request, parent, isMain, options);
};
