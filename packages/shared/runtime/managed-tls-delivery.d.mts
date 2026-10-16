import type { ManagedServiceMeshRecord } from './managed-service-mesh.mjs';
export type ManagedTlsService = 'gateway' | 'api' | 'web';
type Material = { issuerCertPem: string; certPem: string; keyPem: string };
export function prepareManagedTlsBundle(
  raw: string,
  service: ManagedTlsService,
  record: ManagedServiceMeshRecord,
): { server?: Material; client?: Material };
export function stageManagedTlsDelivery(
  service: ManagedTlsService,
  env?: Record<string, string | undefined>,
  gatewayBuild?: { sourceSha: string; bindingSha256: string },
): {
  directories: Readonly<Record<string, string>>;
  cleanup: () => void;
} | null;
