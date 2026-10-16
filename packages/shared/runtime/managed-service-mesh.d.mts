export type ManagedServiceMeshRecord = Readonly<{
  format: 2;
  provider: 'render';
  region: 'frankfurt';
  installationId: string;
  ownerId: string;
  environmentId: string;
  sourceSha: string;
  publicOrigin: string;
  gatewayServiceId: string;
  webServiceId: string;
  apiServiceId: string;
  schedulerServiceId: string;
  apiServiceName: string;
  apiOrigin: string;
  webServiceName: string;
  webOrigin: string;
  issuerCertSha256: string;
  apiCertSha256: string;
  webCertSha256: string;
  gatewayClientCertSha256: string;
  webClientCertSha256: string;
}>;
export function createManagedServiceMeshBinding(raw: unknown): {
  record: ManagedServiceMeshRecord;
  json: string;
  sha256: string;
};
