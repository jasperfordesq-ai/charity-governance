import assert from 'node:assert/strict';
import test from 'node:test';
import { DOCUMENT_UPLOAD_MAX_FILE_SIZE } from '../routes/documents/document-upload-validation.js';
import type { ConfluenceClient, ConfluenceRequestSpec } from '../services/confluence-client.js';
import {
  CONFLUENCE_ATTACHMENT_MAX_BYTES,
  deleteAttachment,
  listAttachments,
  purgeAttachment,
  uploadAttachment,
} from '../services/confluence-attachments.js';
import { AppError } from '../utils/errors.js';

const PAGE_ID = '123456';
const WEB_BASE = 'https://charity.atlassian.net/wiki';
const DOWNLOAD = '/download/attachments/123456/board-minutes.pdf?version=1&api=v2';
const PDF = 'application/pdf';

type Handler = (spec: ConfluenceRequestSpec) => { status: number; body: unknown };

type Harness = { client: ConfluenceClient; specs: ConfluenceRequestSpec[] };

/** A `ConfluenceClient` wired to scripted handlers. The last handler repeats. */
function harness(handlers: Handler[]): Harness {
  const specs: ConfluenceRequestSpec[] = [];
  const client: ConfluenceClient = {
    async request(spec) {
      specs.push(spec);
      const handler = handlers[Math.min(specs.length - 1, handlers.length - 1)];
      if (handler === undefined) {
        throw new Error(`No scripted response for ${spec.method} ${spec.path}`);
      }
      return handler(spec);
    },
  };
  return { client, specs };
}

function ok(body: unknown): Handler {
  return () => ({ status: 200, body });
}

function throwing(error: AppError): Handler {
  return () => {
    throw error;
  };
}

/** The shape the v1 upload endpoint answers with: a one-element `results` list. */
function v1UploadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    results: [
      {
        id: 'att789',
        type: 'attachment',
        status: 'current',
        title: 'board-minutes.pdf',
        metadata: { mediaType: PDF },
        extensions: { mediaType: PDF, fileSize: 2048 },
        _links: { download: DOWNLOAD, webui: '/pages/123456' },
        ...overrides,
      },
    ],
    size: 1,
    _links: { base: WEB_BASE, context: '/wiki' },
  };
}

/** The shape the v2 list endpoint answers with: flat fields, not v1's `extensions`. */
function v2ListBody(
  results: Record<string, unknown>[] = [
    {
      id: 'att789',
      status: 'current',
      title: 'board-minutes.pdf',
      pageId: PAGE_ID,
      mediaType: PDF,
      fileSize: 2048,
      downloadLink: DOWNLOAD,
      webuiLink: '/pages/123456',
    },
  ],
  links: Record<string, unknown> = { base: WEB_BASE },
): Record<string, unknown> {
  return { results, _links: links };
}

/** The shapes Task 1 throws, reproduced exactly as this module will meet them. */
function upstreamReconnectRequired(status: 401 | 403): AppError {
  return new AppError(
    409,
    'CONFLUENCE_RECONNECT_REQUIRED',
    `Confluence request failed with status ${status}. The charity must reconnect its Confluence site.`,
    { status },
  );
}

function upstreamNotFound(): AppError {
  return new AppError(404, 'CONFLUENCE_NOT_FOUND', 'Confluence request failed with status 404.', {
    status: 404,
  });
}

async function rejectsWith(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got: ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

function bytes(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function uploadInput(overrides: Record<string, unknown> = {}): {
  pageId: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
} {
  return {
    pageId: PAGE_ID,
    filename: 'board-minutes.pdf',
    contentType: PDF,
    bytes: bytes(2048),
    ...overrides,
  } as { pageId: string; filename: string; contentType: string; bytes: Uint8Array };
}

/** The `file` part of a multipart upload, as a `File`. */
function filePart(spec: ConfluenceRequestSpec): File {
  assert.ok(spec.formData !== undefined, 'expected the upload to carry multipart form data');
  const part = spec.formData.get('file');
  assert.ok(part instanceof Blob, 'expected the `file` part to be a Blob/File, not a plain string');
  return part as File;
}

// ---------------------------------------------------------------------------
// The flag the whole phase turns on.
// ---------------------------------------------------------------------------

test('uploadAttachment is issued as non-idempotent so a retry cannot version a charity file twice', async () => {
  const { client, specs } = harness([ok(v1UploadBody())]);

  await uploadAttachment(client, uploadInput());

  assert.equal(specs.length, 1);
  assert.equal(
    specs[0]?.idempotent,
    false,
    'uploadAttachment MUST be non-idempotent: repeating an upload of the same filename ' +
      'creates a new version of the attachment, which is not something to do accidentally',
  );
});

test('listAttachments is issued as idempotent so a rate-limited read is retried', async () => {
  const { client, specs } = harness([ok(v2ListBody())]);

  await listAttachments(client, PAGE_ID);

  assert.equal(specs.length, 1);
  assert.equal(specs[0]?.idempotent, true, 'listing changes nothing and is safe to repeat');
});

// ---------------------------------------------------------------------------
// The v1/v2 split, which is the trap this module exists around.
// ---------------------------------------------------------------------------

test('uploadAttachment posts to the v1 attachment path, because v2 has no upload endpoint', async () => {
  const { client, specs } = harness([ok(v1UploadBody())]);

  await uploadAttachment(client, uploadInput());

  const spec = specs[0];
  assert.ok(spec);
  assert.equal(spec.method, 'POST');
  assert.equal(
    spec.api,
    'v1',
    "upload MUST use v1: Confluence's v2 attachment endpoints are GET and DELETE only",
  );
  assert.equal(spec.path, `content/${PAGE_ID}/child/attachment`);
});

test('uploadAttachment sends X-Atlassian-Token: nocheck, without which Atlassian rejects it as CSRF', async () => {
  const { client, specs } = harness([ok(v1UploadBody())]);

  await uploadAttachment(client, uploadInput());

  const headers = specs[0]?.headers ?? {};
  const tokenHeader = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === 'x-atlassian-token',
  );
  assert.ok(tokenHeader, 'the v1 upload MUST carry an X-Atlassian-Token header');
  assert.equal(tokenHeader[1], 'nocheck');
});

test('uploadAttachment sends the file as multipart and lets fetch own the Content-Type boundary', async () => {
  const { client, specs } = harness([ok(v1UploadBody())]);
  const payload = bytes(2048, 9);

  await uploadAttachment(client, uploadInput({ bytes: payload }));

  const spec = specs[0];
  assert.ok(spec);
  assert.equal(spec.body, undefined, 'a multipart upload carries form data, never a JSON body');

  const part = filePart(spec);
  assert.equal(part.name, 'board-minutes.pdf');
  assert.equal(part.type, PDF);
  assert.equal(part.size, payload.length);
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), payload);

  const contentType = Object.keys(spec.headers ?? {}).find(
    (key) => key.toLowerCase() === 'content-type',
  );
  assert.equal(
    contentType,
    undefined,
    'setting Content-Type here would lose the multipart boundary fetch generates',
  );
});

test('listAttachments reads the v2 endpoint and parses its flat fields', async () => {
  const { client, specs } = harness([ok(v2ListBody())]);

  const attachments = await listAttachments(client, PAGE_ID);

  const spec = specs[0];
  assert.ok(spec);
  assert.equal(spec.method, 'GET');
  assert.equal(spec.api, 'v2', 'listing has a v2 endpoint and must use it');
  assert.equal(spec.path, `pages/${PAGE_ID}/attachments`);
  assert.equal(
    spec.query?.limit,
    '250',
    "v2's maximum page size, and load-bearing: at the default 25 the bounded " +
      'cursor loop reaches ~1,000 attachments instead of ~10,000, which is the ' +
      'truncation the cursor following exists to prevent',
  );

  assert.deepEqual(attachments, [
    {
      id: 'att789',
      title: 'board-minutes.pdf',
      mediaType: PDF,
      fileSize: 2048,
      downloadUrl: `${WEB_BASE}${DOWNLOAD}`,
    },
  ]);
});

test('uploadAttachment parses the v1 response shape, whose fields sit under extensions', async () => {
  const { client } = harness([ok(v1UploadBody())]);

  const attachment = await uploadAttachment(client, uploadInput());

  assert.deepEqual(attachment, {
    id: 'att789',
    title: 'board-minutes.pdf',
    mediaType: PDF,
    fileSize: 2048,
    downloadUrl: `${WEB_BASE}${DOWNLOAD}`,
  });
});

test('listAttachments follows the v2 cursor so a long list is not silently truncated', async () => {
  const first = v2ListBody(
    [
      {
        id: 'att1',
        title: 'a.pdf',
        mediaType: PDF,
        fileSize: 1,
        downloadLink: '/download/a.pdf',
      },
    ],
    { base: WEB_BASE, next: '/wiki/api/v2/pages/123456/attachments?cursor=CURSOR2&limit=250' },
  );
  const second = v2ListBody([
    {
      id: 'att2',
      title: 'b.pdf',
      mediaType: PDF,
      fileSize: 2,
      downloadLink: '/download/b.pdf',
    },
  ]);
  const { client, specs } = harness([ok(first), ok(second)]);

  const attachments = await listAttachments(client, PAGE_ID);

  assert.equal(specs.length, 2);
  assert.equal(specs[1]?.query?.cursor, 'CURSOR2');
  assert.deepEqual(
    attachments.map((attachment) => attachment.id),
    ['att1', 'att2'],
  );
});

test('listAttachments returns an empty list for a page with no attachments', async () => {
  const { client } = harness([ok(v2ListBody([]))]);
  assert.deepEqual(await listAttachments(client, PAGE_ID), []);
});

for (const [what, body] of [
  ['no results key at all', { _links: { base: WEB_BASE } }],
  // Not a duplicate of the case above: `results` is present and truthy, so a
  // guard that merely checked for its presence would hand an object to
  // `for...of` and throw a raw TypeError straight out of the error taxonomy.
  ['a results object rather than a list', { results: {}, _links: { base: WEB_BASE } }],
  ['a results string', { results: 'att1', _links: { base: WEB_BASE } }],
] as const) {
  test(`listAttachments refuses a response with ${what} rather than reporting none`, async () => {
    const { client } = harness([ok(body)]);

    const error = await rejectsWith(() => listAttachments(client, PAGE_ID));

    assert.equal(error.code, 'CONFLUENCE_RESPONSE_INVALID');
    assert.equal(
      error.statusCode,
      502,
      'an unreadable list must not be flattened into "this page has no attachments"',
    );
  });
}

test('listAttachments stops rather than following a cursor forever', async () => {
  const endless = v2ListBody(
    [{ id: 'att1', title: 'a.pdf', mediaType: PDF, fileSize: 1, downloadLink: '/download/a.pdf' }],
    { base: WEB_BASE, next: '/wiki/api/v2/pages/123456/attachments?cursor=SAME&limit=250' },
  );
  const { client, specs } = harness([ok(endless)]);

  const error = await rejectsWith(() => listAttachments(client, PAGE_ID));

  assert.equal(error.code, 'CONFLUENCE_ATTACHMENT_LIST_UNBOUNDED');
  assert.equal(error.statusCode, 502);
  assert.ok(specs.length > 1 && specs.length <= 40, `bounded page count, got ${specs.length}`);
});

test('an absolute download link is left alone and a link with no base is returned as given', async () => {
  const absolute = 'https://cdn.example/att/a.pdf';
  const { client } = harness([
    ok(
      v2ListBody(
        [
          { id: 'att1', title: 'a.pdf', mediaType: PDF, fileSize: 1, downloadLink: absolute },
          { id: 'att2', title: 'b.pdf', mediaType: PDF, fileSize: 2, downloadLink: '/rel/b.pdf' },
          { id: 'att3', title: 'c.pdf' },
        ],
        {},
      ),
    ),
  ]);

  const attachments = await listAttachments(client, PAGE_ID);

  assert.equal(attachments[0]?.downloadUrl, absolute);
  assert.equal(attachments[1]?.downloadUrl, '/rel/b.pdf');
  assert.deepEqual(attachments[2], {
    id: 'att3',
    title: 'c.pdf',
    mediaType: '',
    fileSize: 0,
    downloadUrl: '',
  });
});

test('a base with a trailing slash does not produce a doubled slash in the download URL', async () => {
  const { client } = harness([
    ok(
      v2ListBody(
        [{ id: 'att1', title: 'a.pdf', mediaType: PDF, fileSize: 1, downloadLink: '/download/a.pdf' }],
        { base: `${WEB_BASE}/` },
      ),
    ),
  ]);

  const attachments = await listAttachments(client, PAGE_ID);

  assert.equal(attachments[0]?.downloadUrl, `${WEB_BASE}/download/a.pdf`);
});

test('a relative link without a leading slash is joined onto the base with one', async () => {
  const { client } = harness([
    ok(
      v2ListBody([
        { id: 'att1', title: 'a.pdf', mediaType: PDF, fileSize: 1, downloadLink: 'download/a.pdf' },
      ]),
    ),
  ]);

  const attachments = await listAttachments(client, PAGE_ID);

  assert.equal(attachments[0]?.downloadUrl, `${WEB_BASE}/download/a.pdf`);
});

// v1 states the media type in two places and is not consistent about which.
// The fixtures below each supply exactly one, so neither fallback can be
// shadowed by the other.

test('a v1 upload takes the media type from extensions when metadata carries none', async () => {
  const { client } = harness([
    ok(v1UploadBody({ metadata: undefined, extensions: { mediaType: PDF, fileSize: 2048 } })),
  ]);

  const attachment = await uploadAttachment(client, uploadInput());

  assert.equal(attachment.mediaType, PDF);
  assert.equal(attachment.fileSize, 2048);
});

test('a v1 upload falls back to metadata when extensions carries no media type', async () => {
  const { client } = harness([
    ok(v1UploadBody({ metadata: { mediaType: PDF }, extensions: { fileSize: 2048 } })),
  ]);

  const attachment = await uploadAttachment(client, uploadInput());

  assert.equal(attachment.mediaType, PDF);
  assert.equal(attachment.fileSize, 2048);
});

// ---------------------------------------------------------------------------
// The ceiling, enforced before anything is sent.
// ---------------------------------------------------------------------------

test('the Confluence attachment ceiling is the same 10 MB the portal upload path applies', () => {
  assert.equal(
    CONFLUENCE_ATTACHMENT_MAX_BYTES,
    DOCUMENT_UPLOAD_MAX_FILE_SIZE,
    'a document CharityPilot accepted must not fail only at the Confluence step',
  );
});

test('a file over the ceiling is rejected before any request is made, naming the limit', async () => {
  const { client, specs } = harness([ok(v1UploadBody())]);

  const error = await rejectsWith(() =>
    uploadAttachment(client, uploadInput({ bytes: bytes(CONFLUENCE_ATTACHMENT_MAX_BYTES + 1) })),
  );

  assert.equal(specs.length, 0, 'an oversized file must cost no request at all');
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'CONFLUENCE_ATTACHMENT_TOO_LARGE');
  assert.match(error.message, /10 MB/, 'the error must name the limit the user was held to');
  assert.deepEqual(error.details, {
    filename: 'board-minutes.pdf',
    bytes: CONFLUENCE_ATTACHMENT_MAX_BYTES + 1,
    limitBytes: CONFLUENCE_ATTACHMENT_MAX_BYTES,
  });
});

test('a file exactly at the ceiling is accepted', async () => {
  const { client, specs } = harness([ok(v1UploadBody())]);

  await uploadAttachment(client, uploadInput({ bytes: bytes(CONFLUENCE_ATTACHMENT_MAX_BYTES) }));

  assert.equal(specs.length, 1);
});

test('an empty file is rejected before any request rather than failing at Atlassian', async () => {
  const { client, specs } = harness([ok(v1UploadBody())]);

  const error = await rejectsWith(() => uploadAttachment(client, uploadInput({ bytes: bytes(0) })));

  assert.equal(specs.length, 0);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'CONFLUENCE_ATTACHMENT_EMPTY');
});

test('a filename that is not a string is refused before any request', async () => {
  const { client, specs } = harness([ok(v1UploadBody())]);

  // Not merely defensive typing: a number survives every other clause in the
  // guard — `.length` is undefined, `/[/\\]/.test(42)` is false, and
  // `Array.from(42)` is `[]` — and would reach FormData as the string "42".
  const error = await rejectsWith(() => uploadAttachment(client, uploadInput({ filename: 42 })));

  assert.equal(specs.length, 0);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'CONFLUENCE_ATTACHMENT_FILENAME_INVALID');
});

test('something that is not bytes is refused before any request', async () => {
  const { client, specs } = harness([ok(v1UploadBody())]);

  const error = await rejectsWith(() =>
    uploadAttachment(client, uploadInput({ bytes: 'not bytes' })),
  );

  assert.equal(specs.length, 0);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'CONFLUENCE_ATTACHMENT_INVALID');
});

// ---------------------------------------------------------------------------
// The boundary guards: a malformed id must not reach the core's 500.
// ---------------------------------------------------------------------------

for (const pageId of ['', '../../admin', '123/child', '123?x=1', 'a'.repeat(200), '12 34']) {
  test(`uploadAttachment rejects the malformed page id ${JSON.stringify(pageId)} with a 4xx`, async () => {
    const { client, specs } = harness([ok(v1UploadBody())]);

    const error = await rejectsWith(() => uploadAttachment(client, uploadInput({ pageId })));

    assert.equal(specs.length, 0);
    assert.equal(
      error.statusCode,
      400,
      'a 500 here would fire the production alert webhook on caller-supplied input',
    );
    assert.equal(error.code, 'CONFLUENCE_PAGE_ID_INVALID');
    assert.ok(
      !error.message.includes(pageId) || pageId === '',
      'a diagnostic is not a place to replay untrusted input',
    );
  });

  test(`listAttachments rejects the malformed page id ${JSON.stringify(pageId)} with a 4xx`, async () => {
    const { client, specs } = harness([ok(v2ListBody())]);

    const error = await rejectsWith(() => listAttachments(client, pageId));

    assert.equal(specs.length, 0);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, 'CONFLUENCE_PAGE_ID_INVALID');
  });
}

for (const filename of [
  '',
  '../escape.pdf',
  'dir/file.pdf',
  'back\\slash.pdf',
  'a'.repeat(300),
  // A bare `.` or `..` is not caught by the path-separator clause, and would
  // become the attachment's title in a charity's audit record.
  '.',
  '..',
  // The one the platform does NOT defend. `Blob` normalises an injected `type`
  // to `''`, but `FormData` preserves a filename verbatim into the multipart
  // part — CRLF included — so this guard is the only thing standing between a
  // caller-supplied name and whatever parses that part downstream.
  'notes\r\nX-Injected: yes.pdf',
  'tab\there.pdf',
  'nul\x00byte.pdf',
]) {
  test(`uploadAttachment rejects the filename ${JSON.stringify(filename.slice(0, 20))} before sending`, async () => {
    const { client, specs } = harness([ok(v1UploadBody())]);

    const error = await rejectsWith(() => uploadAttachment(client, uploadInput({ filename })));

    assert.equal(specs.length, 0);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, 'CONFLUENCE_ATTACHMENT_FILENAME_INVALID');
  });
}

// ---------------------------------------------------------------------------
// A 2xx whose body will not parse means the file landed.
// ---------------------------------------------------------------------------

for (const [what, body] of [
  ['no results list', { size: 0, _links: { base: WEB_BASE } }],
  ['an empty results list', { results: [], _links: { base: WEB_BASE } }],
  ['a result with no id', v1UploadBody({ id: null })],
  ['a result that is not an object', { results: ['nope'], _links: { base: WEB_BASE } }],
  ['nothing at all', undefined],
] as const) {
  test(`an upload answered 2xx with ${what} says the file landed, not that the upload failed`, async () => {
    const { client } = harness([ok(body)]);

    const error = await rejectsWith(() => uploadAttachment(client, uploadInput()));

    assert.equal(
      error.code,
      'CONFLUENCE_WRITE_APPLIED_RESPONSE_UNREADABLE',
      'a caller told the upload merely "failed" would upload the charity file a second time',
    );
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /WAS uploaded/);
    assert.match(error.message, /[Dd]o not reissue/);
  });
}

test('a list answered with an unusable attachment is a plain invalid response, not a write-applied one', async () => {
  const { client } = harness([ok(v2ListBody([{ title: 'no-id.pdf' }]))]);

  const error = await rejectsWith(() => listAttachments(client, PAGE_ID));

  assert.equal(error.code, 'CONFLUENCE_RESPONSE_INVALID');
  assert.equal(error.statusCode, 502);
});

// ---------------------------------------------------------------------------
// A 403 on the v1 upload has a cause nothing else in this client has.
// ---------------------------------------------------------------------------

test('a 403 on upload names the stripped CSRF header as a likely cause alongside the grant', async () => {
  const { client } = harness([throwing(upstreamReconnectRequired(403))]);

  const error = await rejectsWith(() => uploadAttachment(client, uploadInput()));

  assert.equal(
    error.code,
    'CONFLUENCE_RECONNECT_REQUIRED',
    'reconnecting is still the action a charity can take, so the code must not change',
  );
  assert.equal(error.statusCode, 409);
  assert.match(error.message, /X-Atlassian-Token/);
  assert.match(error.message, /reconnect/i);
  assert.deepEqual(
    error.details,
    { status: 403, possibleCsrfHeaderStripped: true },
    'a message is the one part of an error a caller cannot branch on: without a ' +
      'discriminator in details, a charity behind a header-stripping proxy reconnects ' +
      'and meets the identical 403',
  );
});

test('a 401 on upload is not dressed up as a CSRF problem', async () => {
  const { client } = harness([throwing(upstreamReconnectRequired(401))]);

  const error = await rejectsWith(() => uploadAttachment(client, uploadInput()));

  assert.equal(error.code, 'CONFLUENCE_RECONNECT_REQUIRED');
  assert.ok(
    !error.message.includes('X-Atlassian-Token'),
    'a 401 is an expired grant and nothing to do with the CSRF header',
  );
  assert.deepEqual(error.details, { status: 401 }, 'and it gains no CSRF discriminator either');
});

// The two codes a caller must receive intact. Each says "reconcile by listing
// the page's attachments"; anything that reshaped them into a generic failure
// would be read as "nothing happened", and the charity's file would go up twice.
for (const raised of [
  new AppError(
    502,
    'CONFLUENCE_REQUEST_INDETERMINATE',
    'A Confluence request that is not safe to repeat did not complete.',
    { status: 503 },
  ),
  new AppError(
    429,
    'CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY',
    'Confluence rate limited a request that is not safe to repeat.',
    { status: 429, retryAfterSeconds: 30 },
  ),
]) {
  test(`an upload passes ${raised.code} through its catch untouched`, async () => {
    const { client } = harness([throwing(raised)]);

    const error = await rejectsWith(() => uploadAttachment(client, uploadInput()));

    assert.equal(
      error,
      raised,
      'the upload catch exists only to explain a 403; it must not reshape a code the caller reconciles on',
    );
  });
}

test('a 403 on listing is left exactly as the core raised it', async () => {
  const raised = upstreamReconnectRequired(403);
  const { client } = harness([throwing(raised)]);

  const error = await rejectsWith(() => listAttachments(client, PAGE_ID));

  assert.equal(error, raised, 'listing sends no CSRF header, so it has nothing to add');
});

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

const ATTACHMENT_ID = 'att789';

test('deleteAttachment and purgeAttachment are issued as idempotent, unlike uploadAttachment', async () => {
  const { client, specs } = harness([ok(undefined), ok(undefined)]);

  await deleteAttachment(client, ATTACHMENT_ID);
  await purgeAttachment(client, ATTACHMENT_ID);

  assert.equal(specs.length, 2);
  assert.equal(
    specs[0]?.idempotent,
    true,
    'deleteAttachment MUST be idempotent: a retried delete cannot duplicate anything, because absence is the goal',
  );
  assert.equal(specs[1]?.idempotent, true, 'purgeAttachment MUST be idempotent for the same reason');
});

test('purge=true is requested on the purge call and on no other', async () => {
  const { client, specs } = harness([ok(undefined), ok(undefined)]);

  await deleteAttachment(client, ATTACHMENT_ID);
  await purgeAttachment(client, ATTACHMENT_ID);

  assert.equal(specs.length, 2);
  assert.equal(specs[0]?.method, 'DELETE');
  assert.equal(specs[0]?.path, `attachments/${ATTACHMENT_ID}`);
  assert.equal(specs[0]?.query, undefined, 'delete must not purge');

  assert.equal(specs[1]?.method, 'DELETE');
  assert.equal(specs[1]?.path, `attachments/${ATTACHMENT_ID}`);
  assert.deepEqual(specs[1]?.query, { purge: 'true' }, 'purge must ask for it explicitly');
});

test('a 404 from deleteAttachment is an accomplished erasure, not a failure', async () => {
  const { client } = harness([throwing(upstreamNotFound())]);

  // Resolves. This is also the shape of a page's delete cascading onto its own
  // attachment: the attachment is already gone, which is already success.
  await deleteAttachment(client, ATTACHMENT_ID);
});

test('a 404 from purgeAttachment is an accomplished erasure, not a failure', async () => {
  const { client } = harness([throwing(upstreamNotFound())]);

  await purgeAttachment(client, ATTACHMENT_ID);
});

test('deleteAttachment does not swallow anything but a 404', async () => {
  const { client } = harness([throwing(upstreamReconnectRequired(403))]);

  const error = await rejectsWith(() => deleteAttachment(client, ATTACHMENT_ID));
  assert.equal(error.code, 'CONFLUENCE_RECONNECT_REQUIRED');
});

test('a forbidden purge names administer space as the missing permission, and says the attachment is only in the trash', async () => {
  const { client } = harness([throwing(upstreamReconnectRequired(403))]);

  const error = await rejectsWith(() => purgeAttachment(client, ATTACHMENT_ID));

  assert.equal(error.code, 'CONFLUENCE_PURGE_FORBIDDEN');
  assert.equal(error.statusCode, 403);
  assert.match(error.message, /administer space/i);
  assert.match(error.message, /trash/i);
  assert.equal((error.details as Record<string, unknown>).permissionRequired, 'administer space');
});

test('a 401 on attachment purge is left as a reconnect, not relabelled as forbidden', async () => {
  const { client } = harness([throwing(upstreamReconnectRequired(401))]);

  const error = await rejectsWith(() => purgeAttachment(client, ATTACHMENT_ID));
  assert.equal(error.code, 'CONFLUENCE_RECONNECT_REQUIRED');
});
