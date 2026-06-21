import assert from 'node:assert/strict';
import test from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'documents-reliability-test-secret';

const [
  { default: Fastify },
  { default: multipart },
  { documentRoutes, DOCUMENT_UPLOAD_MULTIPART_LIMITS },
  { healthRoutes },
  { StorageService },
  { AppError },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('@fastify/multipart'),
  import('../routes/documents/index.js'),
  import('../routes/health/index.js'),
  import('../services/storage.service.js'),
  import('../utils/errors.js'),
  import('../utils/jwt.js'),
]);

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

type SubscriptionRow = { status: string; trialEndsAt: Date | null; plan?: string; currentPeriodEnd?: Date | null };

type PrismaMock = {
  authSession?: { findFirst: () => Promise<{ id: string } | null> };
  user?: { findUnique: () => Promise<{ id: string; organisationId: string; role: Role; emailVerified: boolean } | null> };
  $transaction?: (callback: (tx: PrismaMock) => Promise<unknown>) => Promise<unknown>;
  subscription: { findUnique: () => Promise<SubscriptionRow | null> };
  document: {
    create?: (args: unknown) => Promise<unknown>;
    findFirst?: (args: unknown) => Promise<unknown>;
    delete?: (args: unknown) => Promise<unknown>;
    aggregate?: (args: unknown) => Promise<{ _sum: { fileSize: number | null } }>;
  };
  documentStorageDeletion?: {
    create?: (args: unknown) => Promise<{ id: string }>;
    update?: (args: unknown) => Promise<unknown>;
  };
  governanceStandard?: {
    findUnique?: (args: unknown) => Promise<unknown>;
  };
  organisation?: {
    findUniqueOrThrow?: (args: unknown) => Promise<unknown>;
  };
  documentStandardLink?: {
    create?: (args: unknown) => Promise<unknown>;
    deleteMany?: (args: unknown) => Promise<unknown>;
  };
};

type MultipartFile = {
  filename: string;
  mimetype: string;
  content: Buffer;
};

const baseFields = {
  name: 'Safeguarding policy',
  category: 'POLICY',
};

function tokenFor(role: Role) {
  return `Bearer ${signAccessToken({ userId: 'user-1', organisationId: 'org-1', role, sessionId: 'session-1' })}`;
}

const authHeader = tokenFor('ADMIN');

function authModels(role: Role = 'ADMIN') {
  return {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role, emailVerified: true }) },
  };
}

function activeSubscription() {
  return {
    findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, plan: 'ESSENTIALS', currentPeriodEnd: new Date(Date.now() + 1_000_000_000) }),
  };
}

async function buildDocumentsApp(prisma: PrismaMock, role: Role = 'ADMIN', limits = DOCUMENT_UPLOAD_MULTIPART_LIMITS) {
  const app = Fastify({ logger: false });
  const decoratedPrisma = { ...authModels(role), ...prisma };
  decoratedPrisma.$transaction ??= async (callback: (tx: PrismaMock) => Promise<unknown>) => callback(decoratedPrisma);
  decoratedPrisma.document.aggregate ??= async () => ({ _sum: { fileSize: 0 } });
  app.decorate('prisma', decoratedPrisma as never);
  await app.register(multipart, { limits });
  await app.register(documentRoutes);
  return app;
}

function multipartRequest(fields: Record<string, string>, file: MultipartFile) {
  const boundary = `charitypilot-test-${Date.now().toString(16)}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(`${value}\r\n`));
  }

  chunks.push(Buffer.from(`--${boundary}\r\n`));
  chunks.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`));
  chunks.push(Buffer.from(`Content-Type: ${file.mimetype}\r\n\r\n`));
  chunks.push(file.content);
  chunks.push(Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  };
}

function validPdfFile(): MultipartFile {
  return { filename: 'policy.pdf', mimetype: 'application/pdf', content: Buffer.from('%PDF-1.7\n%%EOF') };
}

function createdDocumentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    organisationId: 'org-1',
    name: 'Safeguarding policy',
    description: null,
    category: 'POLICY',
    fileUrl: 'org-1/policy.pdf',
    fileSize: 14,
    mimeType: 'application/pdf',
    version: 1,
    owner: null,
    approvedDate: null,
    nextReviewDate: null,
    boardMinuteReference: null,
    uploadedById: 'user-1',
    createdAt: new Date('2026-06-08T00:00:00.000Z'),
    updatedAt: new Date('2026-06-08T00:00:00.000Z'),
    standardLinks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

test('GET /:id returns 404 for a document belonging to another organisation', async () => {
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      // org-scoped where {id, organisationId} excludes the foreign row
      findFirst: async () => null,
    },
    organisation: {
      findUniqueOrThrow: async () => ({ complexity: 'SIMPLE' }),
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/foreign-doc',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'DOCUMENT_NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('GET /:id/download returns 404 and never signs a URL for a foreign-org document', { concurrency: false }, async () => {
  const originalGetSignedUrl = StorageService.prototype.getSignedUrl;
  let signedCalled = false;
  StorageService.prototype.getSignedUrl = async () => {
    signedCalled = true;
    return 'https://example.org/signed';
  };

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => null,
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/foreign-doc/download',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'DOCUMENT_NOT_FOUND');
    assert.equal(signedCalled, false);
  } finally {
    StorageService.prototype.getSignedUrl = originalGetSignedUrl;
    await app.close();
  }
});

test('readLocalFile rejects storage paths outside the organisation prefix before reading', { concurrency: false }, async () => {
  const originalDriver = process.env.DOCUMENT_STORAGE_DRIVER;
  process.env.DOCUMENT_STORAGE_DRIVER = 'local';

  async function assertForbidden(action: () => Promise<unknown>) {
    await assert.rejects(action, (err) => {
      assert.equal(err instanceof AppError, true);
      const appError = err as InstanceType<typeof AppError>;
      assert.equal(appError.statusCode, 403);
      assert.equal(appError.code, 'STORAGE_PATH_FORBIDDEN');
      return true;
    });
  }

  try {
    const service = new StorageService();
    await assertForbidden(() => service.readLocalFile('org-a', 'org-b/policy.pdf'));
    await assertForbidden(() => service.readLocalFile('org-a', '../org-a/policy.pdf'));
    await assertForbidden(() => service.readLocalFile('org-a', 'org-a'));
  } finally {
    if (originalDriver === undefined) {
      delete process.env.DOCUMENT_STORAGE_DRIVER;
    } else {
      process.env.DOCUMENT_STORAGE_DRIVER = originalDriver;
    }
  }
});

test('POST /:id/standards rejects linking when the document belongs to another organisation', async () => {
  let linkCreated = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => null,
    },
    governanceStandard: {
      findUnique: async () => ({ id: 's1', isCore: true }),
    },
    organisation: {
      findUniqueOrThrow: async () => ({ complexity: 'COMPLEX' }),
    },
    documentStandardLink: {
      create: async () => {
        linkCreated = true;
        return { documentId: 'foreign-doc', standardId: 's1' };
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/foreign-doc/standards',
      headers: { authorization: authHeader },
      payload: { standardId: 's1' },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'DOCUMENT_NOT_FOUND');
    assert.equal(linkCreated, false);
  } finally {
    await app.close();
  }
});

test('DELETE /:id/standards/:standardId rejects unlinking when the document belongs to another organisation', async () => {
  let deleteCalled = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => null,
    },
    documentStandardLink: {
      deleteMany: async () => {
        deleteCalled = true;
        return { count: 1 };
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/foreign-doc/standards/s1',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'DOCUMENT_NOT_FOUND');
    assert.equal(deleteCalled, false);
  } finally {
    await app.close();
  }
});

test('DELETE /:id rejects and performs no side effects for a document belonging to another organisation', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let storageCalled = false;
  StorageService.prototype.deleteFile = async () => {
    storageCalled = true;
  };

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => null,
      delete: async () => {
        throw new Error('document.delete must not be called for a foreign-org document');
      },
    },
    documentStorageDeletion: {
      create: async () => {
        throw new Error('documentStorageDeletion.create must not be called for a foreign-org document');
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/foreign-doc',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'DOCUMENT_NOT_FOUND');
    assert.equal(storageCalled, false);
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});

test('document upload stores the object under the caller\'s organisation prefix', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let capturedOrganisationId: string | null = null;
  StorageService.prototype.uploadFile = async (organisationId: string) => {
    capturedOrganisationId = organisationId;
    return { storagePath: `${organisationId}/policy.pdf` };
  };

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      create: async () => createdDocumentRow(),
    },
  });

  try {
    const request = multipartRequest(baseFields, validPdfFile());
    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 201);
    // The storage prefix is derived from request.user.organisationId, never from client input.
    assert.equal(capturedOrganisationId, 'org-1');
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// AuthZ boundary (requireAdmin)
// ---------------------------------------------------------------------------

test('a MEMBER cannot upload a document (requireAdmin)', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;
  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.pdf' };
  };

  let createCalled = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      create: async () => {
        createCalled = true;
        return { id: 'doc-1' };
      },
    },
  }, 'MEMBER');

  try {
    const request = multipartRequest(baseFields, validPdfFile());
    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: tokenFor('MEMBER') },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'FORBIDDEN');
    assert.equal(uploadCalled, false);
    assert.equal(createCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('a MEMBER cannot delete a document (requireAdmin)', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let storageCalled = false;
  StorageService.prototype.deleteFile = async () => {
    storageCalled = true;
  };

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => {
        throw new Error('service.remove must not run for a MEMBER');
      },
      delete: async () => {
        throw new Error('document.delete must not run for a MEMBER');
      },
    },
  }, 'MEMBER');

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/doc-1',
      headers: { authorization: tokenFor('MEMBER') },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'FORBIDDEN');
    assert.equal(storageCalled, false);
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});

test('a MEMBER cannot link or unlink a document to a governance standard (requireAdmin)', async () => {
  let linkCreated = false;
  let unlinkCalled = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => {
        throw new Error('document lookup must not run for a MEMBER');
      },
    },
    documentStandardLink: {
      create: async () => {
        linkCreated = true;
        return {};
      },
      deleteMany: async () => {
        unlinkCalled = true;
        return { count: 0 };
      },
    },
  }, 'MEMBER');

  try {
    const linkResponse = await app.inject({
      method: 'POST',
      url: '/doc-1/standards',
      headers: { authorization: tokenFor('MEMBER') },
      payload: { standardId: 's1' },
    });
    assert.equal(linkResponse.statusCode, 403);
    assert.equal(linkResponse.json().code, 'FORBIDDEN');

    const unlinkResponse = await app.inject({
      method: 'DELETE',
      url: '/doc-1/standards/s1',
      headers: { authorization: tokenFor('MEMBER') },
    });
    assert.equal(unlinkResponse.statusCode, 403);
    assert.equal(unlinkResponse.json().code, 'FORBIDDEN');

    assert.equal(linkCreated, false);
    assert.equal(unlinkCalled, false);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Plan gating (subscriptionGuard / quota)
// ---------------------------------------------------------------------------

test('document upload is blocked when the organisation has no subscription record', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;
  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.pdf' };
  };

  let createCalled = false;
  const app = await buildDocumentsApp({
    subscription: { findUnique: async () => null },
    document: {
      create: async () => {
        createCalled = true;
        return { id: 'doc-1' };
      },
    },
  });

  try {
    const request = multipartRequest(baseFields, validPdfFile());
    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'NO_SUBSCRIPTION');
    assert.equal(uploadCalled, false);
    assert.equal(createCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('documents endpoints are blocked when the subscription trial has expired', async () => {
  const app = await buildDocumentsApp({
    subscription: {
      findUnique: async () => ({ status: 'TRIALING', trialEndsAt: new Date(Date.now() - 60_000), plan: 'ESSENTIALS', currentPeriodEnd: null }),
    },
    document: {
      findFirst: async () => {
        throw new Error('document query must not run once the trial has expired');
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'TRIAL_EXPIRED');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('document upload rejects malformed metadata with VALIDATION_ERROR before storage', { concurrency: false }, async () => {
  const originalUpload = StorageService.prototype.uploadFile;
  let uploadCalled = false;
  StorageService.prototype.uploadFile = async () => {
    uploadCalled = true;
    return { storagePath: 'org-1/policy.pdf' };
  };

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      create: async () => ({ id: 'doc-1' }),
    },
  });

  try {
    // Violates exactly the category enum rule; name is present, everything else valid.
    const request = multipartRequest({ name: 'Safeguarding policy', category: 'NOT_A_CATEGORY' }, validPdfFile());
    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { ...request.headers, authorization: authHeader },
      payload: request.payload,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'VALIDATION_ERROR');
    assert.equal(Array.isArray(response.json().details), true);
    assert.equal(uploadCalled, false);
  } finally {
    StorageService.prototype.uploadFile = originalUpload;
    await app.close();
  }
});

test('POST /:id/standards rejects a missing standardId with VALIDATION_ERROR', async () => {
  let linkCreated = false;
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1' }),
    },
    documentStandardLink: {
      create: async () => {
        linkCreated = true;
        return {};
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/doc-1/standards',
      headers: { authorization: authHeader },
      payload: { standardId: '' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'VALIDATION_ERROR');
    assert.equal(linkCreated, false);
  } finally {
    await app.close();
  }
});

test('GET /_local-download requires a path query parameter', async () => {
  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {},
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/_local-download',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'LOCAL_STORAGE_PATH_REQUIRED');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

test('GET /:id/download returns 503 STORAGE_NOT_CONFIGURED when Supabase is unconfigured', { concurrency: false }, async () => {
  const originalDriver = process.env.DOCUMENT_STORAGE_DRIVER;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.DOCUMENT_STORAGE_DRIVER;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {
      findFirst: async () => ({ fileUrl: 'org-1/policy.pdf' }),
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/doc-1/download',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'STORAGE_NOT_CONFIGURED');
  } finally {
    if (originalDriver === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = originalDriver;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    await app.close();
  }
});

test('GET /_local-download returns 503 when the local storage driver is disabled', { concurrency: false }, async () => {
  const originalDriver = process.env.DOCUMENT_STORAGE_DRIVER;
  delete process.env.DOCUMENT_STORAGE_DRIVER;

  const app = await buildDocumentsApp({
    subscription: activeSubscription(),
    document: {},
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/_local-download?path=org-1/policy.pdf',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'STORAGE_NOT_CONFIGURED');
  } finally {
    if (originalDriver === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = originalDriver;
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Observability (readiness)
// ---------------------------------------------------------------------------

test('readiness reports not_ready when the document storage bucket is unreachable', { concurrency: false }, async () => {
  const originalReadinessKey = process.env.READINESS_API_KEY;
  const originalIsConfigured = StorageService.prototype.isConfigured;
  const originalVerifyBucket = StorageService.prototype.verifyBucket;

  process.env.READINESS_API_KEY = 'readiness-test-secret';
  StorageService.prototype.isConfigured = function isConfigured() {
    return true;
  };
  StorageService.prototype.verifyBucket = async function verifyBucket() {
    return false;
  };

  const app = Fastify({ logger: false });
  app.decorate('prisma', { $queryRaw: async () => [{ result: 1 }] } as never);
  await app.register(healthRoutes, { prefix: '/api/v1/health' });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { 'x-charitypilot-readiness-key': 'readiness-test-secret' },
    });

    assert.equal(response.statusCode, 503);
    const body = response.json();
    assert.equal(body.status, 'not_ready');
    assert.equal(body.checks.storageBucketReachable, false);
  } finally {
    StorageService.prototype.isConfigured = originalIsConfigured;
    StorageService.prototype.verifyBucket = originalVerifyBucket;
    if (originalReadinessKey === undefined) delete process.env.READINESS_API_KEY;
    else process.env.READINESS_API_KEY = originalReadinessKey;
    await app.close();
  }
});
