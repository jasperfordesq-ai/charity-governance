import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readUploadable,
  writeDownload,
  resolveInsideRoot,
  FileAccessError,
  UPLOAD_MIME_BY_EXTENSION,
  UPLOAD_MAX_BYTES,
} from '../files.js';
import { FILE_TOOLS, runFileTool, unavailableBecause } from '../file-tools.js';
import type { ApiClient } from '../client.js';
import type { ConnectorConfig } from '../config.js';

const PDF = Buffer.from('%PDF-1.4\nnot a real document\n', 'utf8');

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-files-'));
  const outside = mkdtempSync(join(tmpdir(), 'charitypilot-outside-'));
  writeFileSync(join(root, 'minutes.pdf'), PDF);
  writeFileSync(join(outside, 'secrets.pdf'), PDF);
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'nested.pdf'), PDF);
  return { root, outside };
}

function config(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    command: 'serve',
    baseUrl: 'https://example.test',
    allowPersonalData: false,
    profile: 'default',
    accessLevel: 'write',
    passwordStdin: false,
    verbose: false,
    ...overrides,
  };
}

test('a file inside the named directory is readable', () => {
  const { root } = sandbox();
  const file = readUploadable(root, 'minutes.pdf');

  assert.equal(file.name, 'minutes.pdf');
  assert.equal(file.mimeType, 'application/pdf');
  assert.deepEqual(file.bytes, PDF);
});

test('a nested file is readable, because a directory means its contents', () => {
  const { root } = sandbox();
  assert.doesNotThrow(() => readUploadable(root, join('sub', 'nested.pdf')));
});

test('a path climbing out of the directory is refused', () => {
  const { root, outside } = sandbox();

  assert.throws(
    () => readUploadable(root, join('..', '..', 'etc', 'passwd')),
    FileAccessError,
  );
  assert.throws(
    () => readUploadable(root, resolve(outside, 'secrets.pdf')),
    /outside the directory this connector may use/,
  );
});

test('a symbolic link pointing out of the directory is refused', {
  skip: platform() === 'win32' ? 'symlinks need elevation on Windows' : false,
}, () => {
  const { root, outside } = sandbox();
  symlinkSync(join(outside, 'secrets.pdf'), join(root, 'looks-inside.pdf'));

  assert.throws(
    () => readUploadable(root, 'looks-inside.pdf'),
    /outside the directory this connector may use/,
    'containment decided on the spelling alone would pass this',
  );
});

test('a dotted or excluded directory is never traversed', () => {
  const { root } = sandbox();
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config.txt'), Buffer.from('token=secret', 'utf8'));
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'thing.txt'), Buffer.from('x', 'utf8'));

  assert.throws(() => readUploadable(root, join('.git', 'config.txt')), /never reads/);
  assert.throws(() => readUploadable(root, join('node_modules', 'thing.txt')), /never reads/);
});

test('a file type CharityPilot does not accept is refused before it is sent', () => {
  const { root } = sandbox();
  writeFileSync(join(root, 'script.sh'), Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8'));

  assert.throws(() => readUploadable(root, 'script.sh'), /does not accept \.sh/);
});

test('a file with no extension is refused, rather than guessed at', () => {
  const { root } = sandbox();
  writeFileSync(join(root, 'anonymous'), PDF);

  assert.throws(() => readUploadable(root, 'anonymous'), /no extension/);
});

test('a file larger than the ceiling is refused before it is read into memory', () => {
  const { root } = sandbox();
  const big = join(root, 'big.pdf');
  writeFileSync(big, Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0x20));

  assert.throws(() => readUploadable(root, 'big.pdf'), /accepts files up to 10 MB/);
});

test('a missing directory says so rather than reporting a missing file', () => {
  assert.throws(
    () => resolveInsideRoot(join(tmpdir(), 'charitypilot-does-not-exist-at-all'), 'x.pdf'),
    /configured directory does not exist/,
  );
});

test('the root itself is not a file to upload', () => {
  const { root } = sandbox();
  assert.throws(() => resolveInsideRoot(root, '.'), FileAccessError);
});

test('a downloaded file is written owner-only, inside the named directory', () => {
  const { root } = sandbox();
  const written = writeDownload(join(root, 'downloads'), 'board-minutes.pdf', PDF);

  assert.ok(written.path.startsWith(join(root, 'downloads')));
  assert.deepEqual(readFileSync(written.path), PDF);
  assert.equal(written.sha256.length, 64);

  if (platform() !== 'win32') {
    assert.equal(statSync(written.path).mode & 0o777, 0o600);
  }
});

test('a document named to escape lands inside the directory anyway', () => {
  const { root } = sandbox();
  const written = writeDownload(join(root, 'downloads'), '../../id_rsa', PDF);

  assert.ok(
    written.path.startsWith(join(root, 'downloads')),
    'a name is not a path, and must not be treated as one',
  );
  assert.ok(!written.path.includes('..'));
});

test('a document with an unusable name still gets one', () => {
  const { root } = sandbox();
  const written = writeDownload(join(root, 'downloads'), '///', PDF);

  assert.ok(written.path.endsWith('document'));
});

test('the accepted types match the ones the API allows', () => {
  // The API refuses anything else, so a connector that offered more would only
  // produce refusals a caller could not act on.
  const api = readFileSync(
    new URL(
      '../../../apps/api/src/routes/documents/document-upload-validation.ts',
      import.meta.url,
    ),
    'utf8',
  );

  for (const [extension, mime] of Object.entries(UPLOAD_MIME_BY_EXTENSION)) {
    assert.ok(api.includes(`'${mime}'`), `${mime} is not in the API allowlist`);
    assert.ok(api.includes(`'${extension}'`), `${extension} is not in the API allowlist`);
  }

  const apiMax = /DOCUMENT_UPLOAD_MAX_FILE_SIZE = (\d+) \* 1024 \* 1024/.exec(api);
  assert.ok(apiMax, 'the API ceiling must be readable');
  assert.equal(
    UPLOAD_MAX_BYTES,
    Number(apiMax[1]) * 1024 * 1024,
    'a connector ceiling above the API one only moves the refusal later',
  );
});

test('uploading is off unless the operator named a directory', async () => {
  const tool = FILE_TOOLS.find((t) => t.name === 'document_upload')!;

  await assert.rejects(
    () => runFileTool(tool, {} as ApiClient, config(), { path: 'x.pdf', name: 'x', category: 'POLICY' }),
    /Uploading is off/,
  );
  assert.match(unavailableBecause(tool), /--upload-root/);
});

test('downloading is off unless the operator named a directory', async () => {
  const tool = FILE_TOOLS.find((t) => t.name === 'document_download')!;

  await assert.rejects(
    () => runFileTool(tool, {} as ApiClient, config(), { id: 'doc-1' }),
    /Downloading is off/,
  );
  assert.match(unavailableBecause(tool), /--download-dir/);
});

test('an argument the file tool does not declare is refused', async () => {
  const { root } = sandbox();
  const tool = FILE_TOOLS.find((t) => t.name === 'document_upload')!;

  await assert.rejects(
    () =>
      runFileTool(tool, {} as ApiClient, config({ uploadRoot: root }), {
        path: 'minutes.pdf',
        name: 'Minutes',
        category: 'BOARD_MINUTES',
        organisationId: 'someone-else',
      }),
    /Unknown argument "organisationId"/,
  );
});

test('an upload sends the file and its metadata, and reports what was sent', async () => {
  const { root } = sandbox();
  const tool = FILE_TOOLS.find((t) => t.name === 'document_upload')!;
  let sent: { name: string; mimeType: string; bytes: Buffer } | null = null;
  let fields: Record<string, string> = {};

  const client = {
    upload: async (
      _path: string,
      file: { name: string; mimeType: string; bytes: Buffer },
      given: Record<string, string>,
    ) => {
      sent = file;
      fields = given;
      return { data: { id: 'doc-9', name: given['name'] } };
    },
  } as unknown as ApiClient;

  const result = (await runFileTool(tool, client, config({ uploadRoot: root }), {
    path: 'minutes.pdf',
    name: 'January board minutes',
    category: 'BOARD_MINUTES',
    reason: 'The owner asked for it',
  })) as { uploaded: Record<string, unknown> };

  assert.equal(sent!.mimeType, 'application/pdf');
  assert.deepEqual(fields, { name: 'January board minutes', category: 'BOARD_MINUTES' });
  assert.equal(result.uploaded['id'], 'doc-9');
  assert.equal(result.uploaded['bytes'], PDF.length);
});

test('a download reports the path and never the bytes', async () => {
  const { root } = sandbox();
  const tool = FILE_TOOLS.find((t) => t.name === 'document_download')!;

  const client = {
    download: async () => ({ bytes: PDF, fileName: 'minutes.pdf' }),
  } as unknown as ApiClient;

  const result = (await runFileTool(tool, client, config({ downloadDir: join(root, 'out') }), {
    id: 'doc-9',
  })) as { saved: Record<string, unknown> };

  assert.ok(String(result.saved['path']).endsWith('minutes.pdf'));
  assert.equal(result.saved['bytes'], PDF.length);
  assert.ok(
    !JSON.stringify(result).includes('not a real document'),
    'the contents must stay out of the model context even when the file is on disk',
  );
});

test('a download identifier is checked before it reaches a URL', async () => {
  const { root } = sandbox();
  const tool = FILE_TOOLS.find((t) => t.name === 'document_download')!;
  const client = {
    download: async () => assert.fail('nothing should be requested'),
  } as unknown as ApiClient;

  await assert.rejects(
    () => runFileTool(tool, client, config({ downloadDir: root }), { id: '../../auth/me' }),
    /must be an identifier/,
  );
});

test('a linked directory pointing out of the root is refused', () => {
  // Runs everywhere: a directory junction needs no elevation on Windows, where
  // a file symbolic link does. Without this the containment check would be
  // untested on the platform this is developed on, and a check decided on the
  // spelling alone would pass every other test in this file.
  const { root, outside } = sandbox();
  const linkPath = join(root, 'linked');
  try {
    symlinkSync(outside, linkPath, 'junction');
  } catch {
    return; // No privilege to link at all; the symlink test above covers it.
  }

  assert.throws(
    () => readUploadable(root, join('linked', 'secrets.pdf')),
    /outside the directory this connector may use/,
  );
});

/* --- Phase C: the export, and an upload for a client with no disk --------- */

test('the compliance report is written to the directory and never returned', async () => {
  const { root } = sandbox();
  const tool = FILE_TOOLS.find((t) => t.name === 'report_export')!;
  const html = Buffer.from('<!doctype html><title>Compliance report</title>', 'utf8');

  let asked = '';
  const client = {
    download: async (path: string) => {
      asked = path;
      return { bytes: html, fileName: null };
    },
  } as unknown as ApiClient;

  const result = (await runFileTool(tool, client, config({ downloadDir: join(root, 'out') }), {
    year: 2026,
  })) as { saved: Record<string, unknown> };

  assert.match(asked, /^\/api\/v1\/export\/compliance-report\?year=2026$/);
  assert.match(String(result.saved['path']), /compliance-report-2026\.html$/);
  assert.equal(result.saved['bytes'], html.length);
  assert.ok(!JSON.stringify(result).includes('<!doctype'), 'the widest payload in the API stays off the wire');
});

test('the export is unavailable until a directory is named', async () => {
  const tool = FILE_TOOLS.find((t) => t.name === 'report_export')!;
  await assert.rejects(
    () => runFileTool(tool, {} as ApiClient, config(), {}),
    /Downloading is off/,
  );
});

test('text can be filed as a document without a file on disk', async () => {
  const tool = FILE_TOOLS.find((t) => t.name === 'document_upload_text')!;
  let sent: { name: string; mimeType: string; bytes: Buffer } | undefined;
  let fields: Record<string, string> | undefined;
  const client = {
    upload: async (
      _path: string,
      file: { name: string; mimeType: string; bytes: Buffer },
      given: Record<string, string>,
    ) => {
      sent = file;
      fields = given;
      return { data: { id: 'doc-11', name: given['name'] } };
    },
  } as unknown as ApiClient;

  const result = (await runFileTool(tool, client, config(), {
    name: 'Reserves policy note',
    category: 'POLICY',
    format: 'txt',
    content: 'The board reviewed the reserves policy on 4 January 2026.',
  })) as { uploaded: Record<string, unknown> };

  assert.equal(sent!.mimeType, 'text/plain');
  assert.match(sent!.name, /\.txt$/);
  assert.equal(sent!.bytes.toString('utf8'), 'The board reviewed the reserves policy on 4 January 2026.');
  assert.equal(fields!['category'], 'POLICY');
  assert.equal(result.uploaded['id'], 'doc-11');
});

test('a text upload needs no directory, because nothing is read from this machine', () => {
  const tool = FILE_TOOLS.find((t) => t.name === 'document_upload_text')!;
  assert.equal(tool.requires, 'nothing');
});

test('a text upload refuses an unsupported format and anything oversized', async () => {
  const tool = FILE_TOOLS.find((t) => t.name === 'document_upload_text')!;
  const client = { upload: async () => ({ data: { id: 'x' } }) } as unknown as ApiClient;

  await assert.rejects(
    () => runFileTool(tool, client, config(), {
      name: 'A note', category: 'POLICY', format: 'pdf', content: 'x',
    }),
    /format/,
  );

  await assert.rejects(
    () => runFileTool(tool, client, config(), {
      name: 'A note',
      category: 'POLICY',
      format: 'txt',
      content: 'x'.repeat(64 * 1024 + 1),
    }),
    /64/,
  );
});
