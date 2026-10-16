import type { X509Certificate } from "node:crypto";
export function tlsCertificateIsCurrent(cert: X509Certificate): boolean;
export function tlsCertificateDigest(cert: X509Certificate): string;
export function validateManagedTlsIdentity(
  material: { issuerCertPem: string; certPem: string; keyPem: string },
  issuerDigest: string,
  leafDigest: string,
  purpose: "server" | "client",
  hostname?: string,
): { issuer: X509Certificate; leaf: X509Certificate };
