import assert from 'node:assert/strict';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SupabaseStorageWriterControl } from '../../services/supabase-storage-writer-control.js';
import { ManagedS3MaintenanceEvidence } from '../../services/managed-s3-maintenance-evidence.js';
import { s3FeatureHash as hash } from '../../services/s3-feature-boundary-contract.js';
type Storage = {
  installationId: string;
  bucket: string;
  accountId: string;
  kmsKeyArn: string;
};
export function managedS3CurrentFixture(
  storage: Storage,
  client: S3Client,
  metadata: SupabaseStorageWriterControl,
  control: { id: string; secret: string },
  events: string[],
) {
  const scope = metadata.s3FeatureProofScope(),
    objects = new Map<string, Buffer>(),
    calls: { method: string; url: string }[] = [],
    mode = {
      staleGateway: false,
      stalePostGateway: false,
      lostCanaryAck: false,
    };
  const registry = {
    mode: 'CURRENT_DISABLED',
    installationId: scope.installationId,
    projectRef: scope.projectRef,
    region: scope.region,
    bucket: 'charitypilot-recovery-s3-probes',
    providerRelease: { sourceSha: '3'.repeat(40), imageDigest: '4'.repeat(64) },
    control: { id: control.id, sha256: hash(control.secret) },
  };
  const transport: typeof fetch = async (input, init) => {
    const u = new URL(String(input)),
      method = init!.method!,
      h = new Headers(init!.headers),
      headers = { date: new Date().toUTCString() };
    assert.ok(
      [
        'https://' + scope.projectRef + '.storage.supabase.co',
        'https://' + scope.projectRef + '.supabase.co',
      ].includes(u.origin),
    );
    assert.equal(init!.redirect, 'error');
    calls.push({ method, url: u.href });
    events.push('s3-feature-' + method);
    if (u.pathname.startsWith('/storage/v1/bucket/')) {
      assert.equal(method, 'GET');
      assert.equal(h.get('apikey'), control.secret);
      return Response.json({ id: registry.bucket, public: false }, { headers });
    }
    if (u.pathname.startsWith('/storage/v1/object/')) {
      assert.equal(h.get('apikey'), control.secret);
      assert.equal(h.has('authorization'), false);
      const key = u.pathname.slice(
        ('/storage/v1/object/' + registry.bucket + '/').length,
      );
      if (method === 'POST') {
        assert.equal(h.get('x-upsert'), 'false');
        if (objects.has(key))
          return new Response(null, { status: 409, headers });
        objects.set(key, Buffer.from(init!.body as Uint8Array));
        if (mode.lostCanaryAck)
          throw new Error(
            'synthetic committed S3 REST canary acknowledgement lost',
          );
        return Response.json({ Key: key }, { headers });
      }
      assert.equal(method, 'GET');
      const v = objects.get(key);
      return v
        ? new Response(v, {
            headers: { ...headers, 'content-length': String(v.length) },
          })
        : new Response(null, { status: 404, headers });
    }
    assert.ok(u.pathname.startsWith('/storage/v1/s3/' + registry.bucket + '/'));
    assert.equal(h.has('apikey'), false);
    assert.equal(h.has('authorization'), false);
    const match =
      /\/charitypilot-recovery-s3-current-probe\/[^/]+\/([^/]+)\/(pre_closure|post_closure)\/(direct|gateway)\//.exec(
        u.pathname,
      );
    assert.ok(match);
    if (u.searchParams.has('uploadId'))
      assert.equal(
        u.searchParams.get('uploadId'),
        'charitypilot-unissued-' + match[1],
      );
    if (u.searchParams.has('X-Amz-Signature'))
      assert.equal(u.searchParams.get('X-Amz-Signature'), '0'.repeat(64));
    const code =
      (mode.staleGateway ||
        (mode.stalePostGateway && match[2] === 'post_closure')) &&
      match[3] === 'gateway'
        ? 'AccessDenied'
        : 'FeatureNotEnabled';
    return new Response('<Error><Code>' + code + '</Code></Error>', {
      status: 403,
      headers: { ...headers, 'content-type': 'application/xml' },
    });
  };
  return {
    mode,
    calls,
    objects,
    transport,
    registry,
    factory: () =>
      new ManagedS3MaintenanceEvidence(
        registry,
        { control },
        metadata,
        null,
        storage,
        { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
        null,
        transport,
        { manifest: client },
      ),
  };
}
