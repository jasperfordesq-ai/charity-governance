import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Preserve the existing valid directory-derived project identity explicitly.
 * A checkout rename or a previously customised project needs operator review;
 * do not invent a new fixed project name or silently normalise an invalid one.
 */
export function productionComposeProjectArgs(root = sourceRoot) {
  const name = basename(root);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error('Production checkout directory must already be a valid Compose project name; review the existing stack identity.');
  }
  return ['--project-name', name];
}
