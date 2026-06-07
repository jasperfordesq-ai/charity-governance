import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'documents-route-test-secret';

const [{ default: Fastify }, { default: multipart }, { documentRoutes }, { StorageService }, { AppError }, { signAccessToken }] =
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
  subscription: { findUnique: () => Promise<{ status: string; trialEndsAt: Date | null }> };
  document: {
    create?: (args: unknown) => Promise<unknown>;
    findFirst?: (args: unknown) => Promise<unknown>;
    delete?: (args: unknown) => Promise<unknown>;
  };
  documentStorageDeletion?: {
    create?: (args: unknown) => Promise<{ id: string }>;
    update?: (args: unknown) => Promise<unknown>;
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
    findUnique: async () => ({ status: 'TRIALING', trialEndsAt: new Date(Date.now() + 60_000) }),
  };
}

async function buildDocumentsApp(prisma: PrismaMock, fileSizeLimit = 1024 * 1024) {
  const app = Fastify({ logger: false });
  const decoratedPrisma = { ...authModels(), ...prisma };
  decoratedPrisma.$transaction ??= async (callback: (tx: PrismaMock) => Promise<unknown>) => callback(decoratedPrisma);
  app.decorate('prisma', decoratedPrisma as never);
  await app.register(multipart, { limits: { fileSize: fileSizeLimit } });
  await app.register(documentRoutes);
  return app;
}

function multipartRequest(fields: Record<string, string>, file: MultipartFile) {
  const boundary = `charitypilot-test-${Math.random().toString(16).slice(2)}`;
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
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
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
  }, 8);

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

test('document delete removes storage after deleting the database record', { concurrency: false }, async () => {
  const originalDeleteFile = StorageService.prototype.deleteFile;
  let order = 0;
  let storageDeleteOrder = 0;
  let databaseDeleteOrder = 0;
  let outboxCreateOrder = 0;
  let outboxProcessedOrder = 0;
  let storageDeleteArgs: string[] = [];

  StorageService.prototype.deleteFile = async (...args: string[]) => {
    storageDeleteArgs = args;
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
      update: async () => {
        outboxProcessedOrder = ++order;
        return {};
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
      update: async () => {
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
    throw new Error('storage unavailable');
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
      update: async (args: unknown) => {
        outboxUpdates.push(args);
        return {};
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
    assert.deepEqual(outboxUpdates, [{
      where: { id: 'deletion-1' },
      data: {
        attempts: { increment: 1 },
        lastError: 'storage unavailable',
      },
    }]);
  } finally {
    StorageService.prototype.deleteFile = originalDeleteFile;
    await app.close();
  }
});
