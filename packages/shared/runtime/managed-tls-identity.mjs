import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
function singlePem(pem, kind) {
  const pattern =
    kind === 'certificate'
      ? /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----(?:\r?\n)?$/
      : /^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1-----(?:\r?\n)?$/;
  if (
    typeof pem !== 'string' ||
    Buffer.byteLength(pem) > 16384 ||
    !pattern.test(pem)
  )
    throw new Error('Managed TLS identity refused');
  return pem;
}
export function parseManagedCertificate(pem) {
  try {
    return new X509Certificate(singlePem(pem, 'certificate'));
  } catch {
    throw new Error('Managed TLS identity refused');
  }
}
export function parseManagedPrivateKey(pem) {
  try {
    return createPrivateKey(singlePem(pem, 'key'));
  } catch {
    throw new Error('Managed TLS identity refused');
  }
}
export function tlsCertificateIsCurrent(cert) {
  const now = Date.now();
  return Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo);
}
export function tlsCertificateDigest(cert) {
  return createHash('sha256').update(cert.raw).digest('hex');
}
export function validateManagedTlsIdentity(
  material,
  issuerDigest,
  leafDigest,
  purpose,
  hostname,
) {
  try {
    const issuer = parseManagedCertificate(material.issuerCertPem),
      leaf = parseManagedCertificate(material.certPem);
    if (
      !issuer.ca ||
      !issuer.checkIssued(issuer) ||
      !issuer.verify(issuer.publicKey) ||
      !tlsCertificateIsCurrent(issuer) ||
      tlsCertificateDigest(issuer) !== issuerDigest ||
      leaf.ca ||
      !tlsCertificateIsCurrent(leaf) ||
      tlsCertificateDigest(leaf) !== leafDigest ||
      !leaf.checkIssued(issuer) ||
      !leaf.verify(issuer.publicKey) ||
      !leaf.keyUsage?.includes(
        purpose === 'server' ? '1.3.6.1.5.5.7.3.1' : '1.3.6.1.5.5.7.3.2',
      ) ||
      !['server', 'client'].includes(purpose) ||
      typeof material.keyPem !== 'string' ||
      Buffer.byteLength(material.keyPem) > 16384 ||
      !leaf.checkPrivateKey(parseManagedPrivateKey(material.keyPem))
    )
      throw Error();
    if (
      purpose === 'server' &&
      (typeof hostname !== 'string' ||
        leaf.checkHost(hostname, {
          subject: 'never',
          wildcards: false,
          partialWildcards: false,
          multiLabelWildcards: false,
        }) !== hostname)
    )
      throw Error();
    return { issuer, leaf };
  } catch {
    throw new Error('Managed TLS identity refused');
  }
}
