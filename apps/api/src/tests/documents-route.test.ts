import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'documents-route-test-secret';

const [
  { default: Fastify },
  { default: multipart },
  { documentRoutes, DOCUMENT_UPLOAD_MULTIPART_LIMITS },
  { StorageService },
  { AppError },
  { signAccessToken },
] =
  await Promise.all([
    import('fastify'),
    import('@fastify/multipart'),
    import('../routes/documents/index.js'),
    import('../services/storage.service.js'),
    import('../utils/errors.js'),
    import('../utils/jwt.js'),
  ]);

type PrismaMock = {
  authSession?: { findFirst: () => Promise<{ id: string } | null> };
  user?: { findUnique: () => Promise<{ id: string; organisationId: string; role: 'ADMIN'; emailVerified: boolean } | null> };
  $transaction?: (callback: (tx: PrismaMock) => Promise<unknown>) => Promise<unknown>;
  subscription: { findUnique: () => Promise<{ status: string; trialEndsAt: Date | null; plan?: string }> };
  document: {
    create?: (args: unknown) => Promise<unknown>;
    findFirst?: (args: unknown) => Promise<unknown>;
    delete?: (args: unknown) => Promise<unknown>;
    aggregate?: (args: unknown) => Promise<{ _sum: { fileSize: number | null } }>;
  };
  documentStorageDeletion?: {
    create?: (args: unknown) => Promise<{ id: string }>;
    findFirst?: (args: unknown) => Promise<unknown>;
    findMany?: (args: unknown) => Promise<unknown[]>;
    updateMany?: (args: unknown) => Promise<{ count: number }>;
  };
  documentStorageDeletionRecovery?: { create?: (args: unknown) => Promise<{ id: string }> };
  governanceStandard?: {
    findUnique?: (args: unknown) => Promise<unknown>;
  };
  organisation?: {
    findUniqueOrThrow?: (args: unknown) => Promise<unknown>;
  };
  documentStandardLink?: {
    create?: (args: unknown) => Promise<unknown>;
  };
};

type MultipartFile = {
  filename: string;
  mimetype: string;
  content: Buffer;
};

type MultipartPart =
  | { type: 'field'; name: string; value: string }
  | { type: 'file'; name?: string; file: MultipartFile };

const baseFields = {
  name: 'Safeguarding policy',
  category: 'POLICY',
};

const authHeader = `Bearer ${signAccessToken({
  userId: 'user-1',
  organisationId: 'org-1',
  role: 'ADMIN',
  sessionId: 'session-1',
})}`;

function authModels() {
  return {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'ADMIN' as const, emailVerified: true }) },
  };
}

function subscription() {
  return {
    findUnique: async () => ({ status: 'TRIALING', trialEndsAt: new Date(Date.now() + 60_000), plan: 'ESSENTIALS' }),
  };
}

async function buildDocumentsApp(prisma: PrismaMock, limits = DOCUMENT_UPLOAD_MULTIPART_LIMITS) {
  const app = Fastify({ logger: false });
  const decoratedPrisma = { ...authModels(), ...prisma };
  decoratedPrisma.$transaction ??= async (callback: (tx: PrismaMock) => Promise<unknown>) => callback(decoratedPrisma);
  decoratedPrisma.document.aggregate ??= async () => ({ _sum: { fileSize: 0 } });
  app.decorate('prisma', decoratedPrisma as never);
  await app.register(multipart, { limits });
  await app.register(documentRoutes);
  return app;
}

function multipartRequest(fields: Record<string, string>, file: MultipartFile) {
  return multipartRequestFromParts([
    ...Object.entries(fields).map(([name, value]) => ({ type: 'field' as const, name, value })),
    { type: 'file' as const, file },
  ]);
}

function multipartRequestFromParts(parts: MultipartPart[]) {
  const boundary = `charitypilot-test-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    if (part.type === 'field') {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(`${part.value}\r\n`));
      continue;
    }

    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name ?? 'file'}"; filename="${part.file.filename}"\r\n`));
    chunks.push(Buffer.from(`Content-Type: ${part.file.mimetype}\r\n\r\n`));
    chunks.push(part.file.content);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  };
}

function publicDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    organisationId: 'org-1',
    name: 'Safeguarding policy',
    description: null,
    category: 'POLICY',
    fileUrl: 'org-1/policy.txt',
    fileSize: 12,
    mimeType: 'text/plain',
    owner: null,
    approvedDate: null,
    nextReviewDate: null,
    boardMinuteReference: null,
    uploadedById: 'user-1',
    createdAt: new Date('2026-06-08T00:00:00.000Z'),
    updatedAt: new Date('2026-06-08T00:00:00.000Z'),
    version: 1,
    standardLinks: [],
    uploadedBy: { id: 'user-1', name: 'Admin User' },
    ...overrides,
  };
}

test('document upload rejects files whose signature does not match the claimed document type', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.pdf' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => ({ id: 'doc-1' }),
    },
  });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.pdf',
      mimetype: 'application/pdf',
      content: Buffer.from('not a pdf'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'INVALID_FILE_SIGNATURE');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload rejects macro-capable legacy Office files before storage', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.doc' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => ({ id: 'doc-1' }),
    },
  });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.doc',
      mimetype: 'application/msword',
      content: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'INVALID_MIME_TYPE');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload translates multipart file size errors to 413', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.txt' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => ({ id: 'doc-1' }),
    },
  }, { ...DOCUMENT_UPLOAD_MULTIPART_LIMITS, fileSize: 8 });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.txt',
      mimetype: 'text/plain',
      content: Buffer.from('123456789'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().code, 'FILE_TOO_LARGE');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload rejects requests with too many multipart fields before storage', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.txt' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => publicDocument(),
    },
  });

  try {
    const request = multipartRequest({
      ...baseFields,
      description: 'A policy for safeguarding.',
      owner: 'Board',
      approvedDate: '2026-06-08',
      nextReviewDate: '2027-06-08',
      boardMinuteReference: 'BM-2026-06',
      unexpected: 'this extra field should exceed the upload request shape',
    }, {
      filename: 'policy.txt',
      mimetype: 'text/plain',
      content: Buffer.from('plain policy text'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().code, 'MULTIPART_LIMIT_EXCEEDED');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload rejects requests with more than one file before storage', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.txt' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => publicDocument(),
    },
  });

  try {
    const request = multipartRequestFromParts([
      ...Object.entries(baseFields).map(([name, value]) => ({ type: 'field' as const, name, value })),
      {
        type: 'file',
        file: { filename: 'policy.txt', mimetype: 'text/plain', content: Buffer.from('plain policy text') },
      },
      {
        type: 'file',
        name: 'attachment',
        file: { filename: 'extra.txt', mimetype: 'text/plain', content: Buffer.from('extra file') },
      },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().code, 'MULTIPART_LIMIT_EXCEEDED');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload rejects oversized multipart field values before storage', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;

  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.txt' };
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => publicDocument(),
    },
  });

  try {
    const request = multipartRequest({
      ...baseFields,
      description: 'x'.repeat(DOCUMENT_UPLOAD_MULTIPART_LIMITS.fieldSize + 1),
    }, {
      filename: 'policy.txt',
      mimetype: 'text/plain',
      content: Buffer.from('plain policy text'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().code, 'MULTIPART_LIMIT_EXCEEDED');
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('document upload deletes the stored object when database creation fails', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  const originalDelete = StorageService.prototype.deleteFile;
  const deletedPaths: Array<{ organisationId: string; storagePath: string }> = [];

  StorageService.prototype.uploadFile = async () => ({ storagePath: 'org-1/policy.pdf' });
  StorageService.prototype.deleteFile = async (organisationId: string, storagePath: string) => {
    deletedPaths.push({ organisationId, storagePath });
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => {
        throw new Error('database unavailable');
      },
    },
  });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.pdf',
      mimetype: 'application/pdf',
      content: Buffer.from('%PDF-1.7\n%%EOF'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(deletedPaths, [{ organisationId: 'org-1', storagePath: 'org-1/policy.pdf' }]);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    StorageService.prototype.deleteFile = originalDelete;
    await app.close();
  }
});

test('document upload rejects files that would exceed the plan storage quota and cleans up storage', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  const originalDelete = StorageService.prototype.deleteFile;
  const deletedPaths: Array<{ organisationId: string; storagePath: string }> = [];
  let createCalled = false;

  StorageService.prototype.uploadFile = async () => ({ storagePath: 'org-1/policy.pdf' });
  StorageService.prototype.deleteFile = async (organisationId: string, storagePath: string) => {
    deletedPaths.push({ organisationId, storagePath });
  };

  const app = await buildDocumentsApp({
    subscription: {
      findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, plan: 'ESSENTIALS' }),
    },
    document: {
      aggregate: async () => ({ _sum: { fileSize: 2 * 1024 * 1024 * 1024 - 10 } }),
      create: async () => {
        createCalled = true;
        return publicDocument({ fileUrl: 'org-1/policy.pdf', mimeType: 'application/pdf' });
      },
    },
  });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.pdf',
      mimetype: 'application/pdf',
      content: Buffer.from('%PDF-1.7\n%%EOF'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'DOCUMENT_STORAGE_QUOTA_EXCEEDED');
    assert.equal(createCalled, false);
    assert.deepEqual(deletedPaths, [{ organisationId: 'org-1', storagePath: 'org-1/policy.pdf' }]);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    StorageService.prototype.deleteFile = originalDelete;
    await app.close();
  }
});

test('document upload preserves the database error when storage cleanup fails', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  const originalDelete = StorageService.prototype.deleteFile;

  StorageService.prototype.uploadFile = async () => ({ storagePath: 'org-1/policy.pdf' });
  StorageService.prototype.deleteFile = async () => {
    throw new Error('storage cleanup unavailable');
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      create: async () => {
        throw new AppError(400, 'DOCUMENT_CREATE_FAILED', 'Document creation failed');
      },
    },
  });

  try {
    const request = multipartRequest(baseFields, {
      filename: 'policy.pdf',
      mimetype: 'application/pdf',
      content: Buffer.from('%PDF-1.7\n%%EOF'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'DOCUMENT_CREATE_FAILED');
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    StorageService.prototype.deleteFile = originalDelete;
    await app.close();
  }
});

test('Essentials organisations cannot link documents to additional governance standards', async () => {
  let linkCreated = false;
  const app = await buildDocumentsApp({
    subscription: {
      findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, plan: 'ESSENTIALS' }),
    },
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1' }),
    },
    organisation: {
      findUniqueOrThrow: async () => ({ complexity: 'COMPLEX' }),
    },
    governanceStandard: {
      findUnique: async () => ({ id: 'additional-standard', isCore: false }),
    },
    documentStandardLink: {
      create: async () => {
        linkCreated = true;
        return { documentId: 'doc-1', standardId: 'additional-standard' };
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/doc-1/standards',
      headers: { authorization: authHeader },
      payload: { standardId: 'additional-standard' },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'COMPLIANCE_STANDARD_NOT_INCLUDED_IN_PLAN');
    assert.equal(linkCreated, false);
  } finally {
    await app.close();
  }
});

test('document delete removes storage after deleting the database record', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let order = 0;
  let storageDeleteOrder = 0;
  let databaseDeleteOrder = 0;
  let outboxCreateOrder = 0;
  let outboxProcessedOrder = 0;
  let storageDeleteArgs: string[] = [];

  StorageService.prototype.deleteFile = async (organisationId: string, storagePath: string) => {
    storageDeleteArgs = [organisationId, storagePath];
    storageDeleteOrder = ++order;
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf' }),
      delete: async () => {
        databaseDeleteOrder = ++order;
        return { id: 'doc-1' };
      },
    },
    documentStorageDeletion: {
      create: async () => {
        outboxCreateOrder = ++order;
        return { id: 'deletion-1' };
      },
      updateMany: async () => {
        outboxProcessedOrder = ++order;
        return { count: 1 };
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/doc-1',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 204);
    assert.deepEqual(storageDeleteArgs, ['org-1', 'org-1/policy.pdf']);
    assert.equal(outboxCreateOrder, 1);
    assert.equal(databaseDeleteOrder, 2);
    assert.equal(storageDeleteOrder, 3);
    assert.equal(outboxProcessedOrder, 4);
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});

test('document delete does not remove storage when database deletion fails', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let storageDeleteCalled = false;

  StorageService.prototype.deleteFile = async () => {
    storageDeleteCalled = true;
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf' }),
      delete: async () => {
        throw new Error('database unavailable');
      },
    },
    documentStorageDeletion: {
      create: async () => ({ id: 'deletion-1' }),
      updateMany: async () => {
        throw new Error('outbox should not be processed');
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/doc-1',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 500);
    assert.equal(storageDeleteCalled, false);
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});

test('document delete reports success when post-delete storage cleanup fails', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let databaseDeleteCalled = false;
  const outboxUpdates: unknown[] = [];

  StorageService.prototype.deleteFile = async () => {
    throw Object.assign(
      new Error('storage unavailable for ops@example.org at org-1/policy.pdf?token=secret-token'),
      { code: 'StorageApiError', status: 503 },
    );
  };

  const app = await buildDocumentsApp({
    subscription: subscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf' }),
      delete: async () => {
        databaseDeleteCalled = true;
        return { id: 'doc-1' };
      },
    },
    documentStorageDeletion: {
      create: async () => ({ id: 'deletion-1' }),
      findFirst: async () => ({
        id: 'deletion-1',
        state: 'PENDING',
        attempts: 0,
        claimedAt: null,
      }),
      updateMany: async (args: unknown) => {
        outboxUpdates.push(args);
        return { count: 1 };
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/doc-1',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 204);
    assert.equal(databaseDeleteCalled, true);
    const lastError = (outboxUpdates[0] as { data: { lastError: string } }).data.lastError;
    assert.match(lastError, /name=Error/);
    assert.match(lastError, /code=StorageApiError/);
    assert.match(lastError, /status=503/);
    assert.match(lastError, /\[email\]/);
    assert.match(lastError, /\[storage-path\]/);
    assert.doesNotMatch(lastError, /ops@example\.org/);
    assert.doesNotMatch(lastError, /secret-token/);
    assert.equal((outboxUpdates[0] as { where: { state: string } }).where.state, 'PENDING');
    assert.deepEqual((outboxUpdates[0] as { data: Record<string, unknown> }).data, {
      state: 'PENDING',
      attempts: 1,
      lastError,
      lastAttemptAt: (outboxUpdates[0] as { data: { lastAttemptAt: Date } }).data.lastAttemptAt,
      nextAttemptAt: (outboxUpdates[0] as { data: { nextAttemptAt: Date } }).data.nextAttemptAt,
      claimedAt: null,
      deadLetteredAt: null,
      terminalReason: null,
      alertClaimToken: null,
      alertClaimedAt: null,
      alertedAt: null,
    });
    assert.ok((outboxUpdates[0] as { data: { lastAttemptAt: Date } }).data.lastAttemptAt instanceof Date);
    assert.ok((outboxUpdates[0] as { data: { nextAttemptAt: Date } }).data.nextAttemptAt instanceof Date);
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});
