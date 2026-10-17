import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { z } from 'zod';
const xml = (v: string | null) =>
  ['application/xml', 'text/xml'].includes(
    v?.split(';')[0].trim().toLowerCase() ?? '',
  );
export function isNativeS3FeatureDisabledError(
  error: unknown,
  status: number,
  contentType: string | null,
) {
  return (
    status === 403 &&
    xml(contentType) &&
    z
      .object({
        name: z.literal('FeatureNotEnabled'),
        Code: z.literal('FeatureNotEnabled'),
        $metadata: z.object({ httpStatusCode: z.literal(403) }),
      })
      .safeParse(error).success
  );
}
/** Bounded local SDK decoding ONLY. This handler never performs network I/O and
 * never receives a real credential, object URL or provider client. */
export async function decodeNativeS3FeatureDisabled(
  response: { status: number; headers: Headers; bytes: Buffer },
  signal?: AbortSignal,
) {
  if (
    response.status !== 403 ||
    !xml(response.headers.get('content-type')) ||
    !(response.bytes instanceof Uint8Array) ||
    response.bytes.byteLength < 1 ||
    response.bytes.byteLength > 32768
  )
    return false;
  signal?.throwIfAborted();
  const bytes = Buffer.from(response.bytes);
  let calls = 0;
  const decoder = new S3Client({
    region: 'eu-west-1',
    endpoint: 'https://s3-feature-decoder.invalid',
    forcePathStyle: true,
    credentials: {
      accessKeyId: 'synthetic-decoder',
      secretAccessKey: 'synthetic-decoder-no-provider-authority',
    },
    maxAttempts: 1,
    followRegionRedirects: false,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      handle: async () => {
        calls++;
        return {
          response: {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: Readable.from([bytes]),
          },
        };
      },
    },
  });
  try {
    await decoder.send(
      new GetObjectCommand({
        Bucket: 'synthetic-decoder',
        Key: 'synthetic-decoder',
      }),
      { abortSignal: signal },
    );
    return false;
  } catch (error) {
    signal?.throwIfAborted();
    return (
      calls === 1 &&
      isNativeS3FeatureDisabledError(
        error,
        response.status,
        response.headers.get('content-type'),
      )
    );
  } finally {
    decoder.destroy();
    bytes.fill(0);
  }
}
