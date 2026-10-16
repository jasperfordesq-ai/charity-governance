import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { productionComposeProjectArgs } from './production-compose-project.mjs';

test('explicit project preserves valid existing checkout basenames',()=>{
  for (const name of ['charity-governence','charity-governance','charitypilot-production','9_charity']) {
    assert.deepEqual(productionComposeProjectArgs(join(tmpdir(),name)),['--project-name',name]);
  }
  assert.deepEqual(productionComposeProjectArgs(),productionComposeProjectArgs(fileURLToPath(new URL('..',import.meta.url)).replace(/[\\/]$/,'')));
});

test('invalid project basenames refuse rather than select a different stack',()=>{
  for (const name of ['Uppercase','with spaces','-leading','_leading','dot.name']) {
    assert.throws(()=>productionComposeProjectArgs(join(tmpdir(),name)),/existing stack identity/);
  }
});
