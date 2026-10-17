import { z } from 'zod';
import { s3ProbeHash as hash } from './s3-capability-contract.js';

export const s3CapabilityTargetSchema = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    projectRef: z.string().regex(/^[a-z0-9]{20}$/),
    endpoint: z.enum(['DIRECT', 'GATEWAY']),
    region: z.enum(['eu-west-1', 'eu-central-1']),
    attemptId: z
      .string()
      .uuid()
      .refine((v) => v === v.toLowerCase()),
    accessKeyIdSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Structural original-target/lifetime validation, not signature verification,
 * provider identity or current authority. Historical custody must remain readable. */
export function assertOriginalS3PresignedUrl(raw: unknown, scope: unknown) {
  const c = s3CapabilityTargetSchema.parse(scope),
    text = z.string().min(1).max(8192).parse(raw),
    url = new URL(text),
    origin =
      'https://' +
      c.projectRef +
      (c.endpoint === 'DIRECT' ? '.storage.supabase.co' : '.supabase.co'),
    path =
      '/storage/v1/s3/charitypilot-recovery-s3-probes/' +
      'charitypilot-recovery-s3-probe/' +
      c.installationId +
      '/' +
      c.attemptId +
      '/presigned.bin';
  const fail = () => {
    throw new Error('Original S3 capability target is unresolved');
  };
  if (
    url.href !== text ||
    url.origin !== origin ||
    url.pathname !== path ||
    url.username ||
    url.password ||
    url.hash
  )
    fail();
  const q = url.searchParams,
    allowed = [
      'X-Amz-Algorithm',
      'X-Amz-Content-Sha256',
      'X-Amz-Credential',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-SignedHeaders',
      'X-Amz-Signature',
      'x-id',
      'x-amz-user-agent',
    ];
  if (
    [...q.keys()].some(
      (k) => !allowed.includes(k) || q.getAll(k).length !== 1,
    ) ||
    q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
    q.get('X-Amz-SignedHeaders') !== 'host' ||
    q.get('X-Amz-Expires') !== '900' ||
    q.get('X-Amz-Content-Sha256') !== 'UNSIGNED-PAYLOAD' ||
    !/^[a-f0-9]{64}$/.test(q.get('X-Amz-Signature') ?? '')
  )
    fail();
  const date = q.get('X-Amz-Date') ?? '',
    credential = (q.get('X-Amz-Credential') ?? '').split('/');
  if (
    !/^\d{8}T\d{6}Z$/.test(date) ||
    credential.length !== 5 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(credential[0]) ||
    hash(credential[0]) !== c.accessKeyIdSha256 ||
    credential[1] !== date.slice(0, 8) ||
    credential[2] !== c.region ||
    credential[3] !== 's3' ||
    credential[4] !== 'aws4_request'
  )
    fail();
  const time = Date.parse(
    date.slice(0, 4) +
      '-' +
      date.slice(4, 6) +
      '-' +
      date.slice(6, 8) +
      'T' +
      date.slice(9, 11) +
      ':' +
      date.slice(11, 13) +
      ':' +
      date.slice(13, 15) +
      'Z',
  );
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().replace(/[-:]/g, '').replace('.000', '') !==
      date
  )
    fail();
  return {
    url: text,
    issuedAt: new Date(time).toISOString(),
    expiresAt: new Date(time + 900000).toISOString(),
  };
}
