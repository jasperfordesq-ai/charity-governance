import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {Readable,Writable} from 'node:stream';
import {S3Client} from '@aws-sdk/client-s3';
import {KMSClient} from '@aws-sdk/client-kms';
type Request = {
  hostname: string;
  protocol: string;
  headers: Record<string, string>;
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
};
export const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest();
export const arn = (n: string) =>
  `arn:aws:kms:eu-west-1:123456789012:key/${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
export const config = {
  installationId: 'fixture',
  bucket: 'synthetic-recovery-sets',
  accountId: '123456789012',
  dataKeyArn: arn('2'),
  storageKeyArn: arn('3'),
  indexMacKeyArn: arn('4'),
  rootMacKeyArn: arn('5'),
};
export const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
export const source = (body: Buffer) =>
  Readable.from(
    (function* () {
      for (let i = 0; i < body.length; i += 65536)
        yield body.subarray(i, i + 65536);
    })(),
  );
export function sink() {
  const chunks: Buffer[] = [];
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }),
  };
}
export function backend(selected=config) {
  const config=selected;
  const objects = new Map<
    string,
    {
      body: Buffer;
      version: string;
      checksum: string;
      type: string;
      contentType: string;
    }
  >();
  const parts = new Map<string, { body: Buffer; checksum: string }[]>(),
    secrets = new Map<string, Buffer>();
  let writes = 0,
    reads = 0,
    generates = 0,
    sequence = 0,
    loseRoot = false,
    losePrepared = false;
  let onRootVerify = () => {};
  const metadata: Record<string, string> = {};
  const encryption = {
    'x-amz-server-side-encryption': 'aws:kms',
    'x-amz-server-side-encryption-aws-kms-key-id': config.storageKeyArn,
  };
  const reply = (
    body: string,
    headers: Record<string, string> = {},
    statusCode = 200,
  ) => ({
    response: {
      statusCode,
      headers: { 'content-type': 'application/xml', ...headers },
      body: Readable.from([body]),
    },
  });
  const body = (request: Request) =>
    typeof request.body === 'string'
      ? Buffer.from(request.body)
      : Buffer.from(request.body as Uint8Array);
  const s3 = () =>
    new S3Client({
      region: 'eu-west-1',
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      credentials,
      maxAttempts: 1,
      requestHandler: {
        async handle(request: Request) {
          assert.match(request.headers.authorization, /AWS4-HMAC-SHA256/);
          assert.equal(request.protocol, 'https:');
          assert.equal(
            request.headers['x-amz-expected-bucket-owner'],
            config.accountId,
          );
          const key = request.path.slice(1);
          if (request.method === 'POST' && 'uploads' in request.query) {
            writes++;
            const id = 'upload-' + ++sequence;
            parts.set(id, []);
            return reply(
              `<InitiateMultipartUploadResult><Bucket>${config.bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
              encryption,
            );
          }
          if (request.method === 'PUT' && request.query.uploadId) {
            writes++;
            const bytes = body(request),
              checksum = hash(bytes).toString('base64');
            assert.equal(request.headers['x-amz-checksum-sha256'], checksum);
            parts.get(request.query.uploadId)!.push({ body: bytes, checksum });
            return reply('', {
              ...encryption,
              etag: '"part"',
              'x-amz-checksum-sha256': checksum,
            });
          }
          if (request.method === 'PUT' || request.method === 'POST') {
            writes++;
            assert.equal(request.headers['if-none-match'], '*');
            if (objects.has(key))
              return reply(
                '<Error><Code>PreconditionFailed</Code></Error>',
                {},
                412,
              );
            const uploaded = request.query.uploadId
              ? parts.get(request.query.uploadId)!
              : undefined;
            const bytes = uploaded
              ? Buffer.concat(uploaded.map((p) => p.body))
              : body(request);
            const checksum = uploaded
              ? hash(
                  Buffer.concat(
                    uploaded.map((p) => Buffer.from(p.checksum, 'base64')),
                  ),
                ).toString('base64') +
                '-' +
                uploaded.length
              : hash(bytes).toString('base64');
            assert.equal(request.headers['x-amz-checksum-sha256'], checksum);
            const version = 'version-' + ++sequence,
              type = uploaded ? 'COMPOSITE' : 'FULL_OBJECT';
            objects.set(key, {
              body: bytes,
              checksum,
              type,
              version,
              contentType: uploaded
                ? 'application/octet-stream'
                : 'application/json',
            });
            if (loseRoot && key.endsWith('/root.json'))
              throw new Error('synthetic lost root ACK');
            if (losePrepared && key.endsWith('/prepared-root.json'))
              throw new Error('synthetic lost prepared ACK');
            return reply(
              uploaded
                ? `<CompleteMultipartUploadResult><Bucket>${config.bucket}</Bucket><Key>${key}</Key><ETag>"complete"</ETag><ChecksumType>${type}</ChecksumType><ChecksumSHA256>${checksum}</ChecksumSHA256></CompleteMultipartUploadResult>`
                : '',
              {
                ...encryption,
                'x-amz-version-id': version,
                'x-amz-checksum-sha256': checksum,
                'x-amz-checksum-type': type,
              },
            );
          }
          assert.equal(request.method, 'GET');
          reads++;
          const value = objects.get(key);
          assert.ok(value, 'missing staged fixture object');
          if (request.query.versionId)
            assert.equal(request.query.versionId, value.version);
          return {
            response: {
              statusCode: 200,
              headers: {
                ...encryption,
                'x-amz-version-id': value.version,
                'x-amz-checksum-sha256': value.checksum,
                'x-amz-checksum-type': value.type,
                'content-type': value.contentType,
                'content-length': String(value.body.length),
                ...metadata,
              },
              body: source(value.body),
            },
          };
        },
      },
    });
  const kms = () =>
    new KMSClient({
      region: 'eu-west-1',
      endpoint: 'https://kms.eu-west-1.amazonaws.com',
      credentials,
      maxAttempts: 1,
      requestHandler: {
        async handle(request: Request) {
          assert.equal(request.hostname, 'kms.eu-west-1.amazonaws.com');
          assert.match(request.headers.authorization, /AWS4-HMAC-SHA256/);
          const input = JSON.parse(body(request).toString()),
            method = request.headers['x-amz-target'];
          let result;
          if (method.endsWith('.GenerateDataKey')) {
            generates++;
            const wrapped = Buffer.from('wrapped-' + generates).toString(
                'base64',
              ),
              key = randomBytes(32);
            secrets.set(wrapped, key);
            result = {
              KeyId: input.KeyId,
              Plaintext: key.toString('base64'),
              CiphertextBlob: wrapped,
            };
          } else if (method.endsWith('.Decrypt')) {
            result = {
              KeyId: input.KeyId,
              Plaintext: secrets.get(input.CiphertextBlob)!.toString('base64'),
              EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
            };
          } else {
            assert.equal(input.MacAlgorithm, 'HMAC_SHA_256');
            assert.match(
              Buffer.from(input.Message, 'base64').toString(),
              input.KeyId === config.rootMacKeyArn
                ? /^CHARITYPILOT_ARCHIVED_RECOVERY_SET_V[12]\n/
                : /^CHARITYPILOT_DOCUMENT_BACKUP_INDEX_V1\n/,
            );
            if (
              input.KeyId === config.rootMacKeyArn &&
              method.endsWith('.VerifyMac')
            )
              onRootVerify();
            const secret = secrets.get(input.KeyId) ?? randomBytes(32);
            secrets.set(input.KeyId, secret);
            const mac = createHmac('sha256', secret)
              .update(Buffer.from(input.Message, 'base64'))
              .digest('base64');
            result = method.endsWith('.GenerateMac')
              ? { KeyId: input.KeyId, MacAlgorithm: 'HMAC_SHA_256', Mac: mac }
              : {
                  KeyId: input.KeyId,
                  MacAlgorithm: 'HMAC_SHA_256',
                  MacValid: input.Mac === mac,
                };
          }
          return reply(JSON.stringify(result), {
            'content-type': 'application/x-amz-json-1.1',
          });
        },
      },
    });
  return {
    s3,
    kms,
    objects,
    metadata,
    set rootVerify(callback: () => void) {
      onRootVerify = callback;
    },
    get reads() {
      return reads;
    },
    get writes() {
      return writes;
    },
    get generates() {
      return generates;
    },
    set loseRoot(value: boolean) {
      loseRoot = value;
    },
    set losePrepared(value: boolean) {
      losePrepared = value;
    },
    close() {
      for (const key of secrets.values()) key.fill(0);
    },
  };
}
