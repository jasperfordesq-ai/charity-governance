import {
  parseManagedCertificate,
  parseManagedPrivateKey,
} from '../../packages/shared/runtime/managed-tls-identity.mjs';
import { createHash } from 'node:crypto';
import { readProtectedTlsMaterial } from '../../packages/shared/runtime/protected-tls-material.mjs';
const refused = () => new Error('Managed gateway TLS material refused');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const certificate = parseManagedCertificate;

function current(cert) {
  const now = Date.now();
  return Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo);
}
export function verifyGatewayTlsMaterial(record, files) {
  try {
    const issuer = certificate(files['issuer.pem']),
      client = certificate(files['client.pem']);
    if (
      !issuer.ca ||
      !issuer.checkIssued(issuer) ||
      !issuer.verify(issuer.publicKey) ||
      !current(issuer) ||
      digest(issuer.raw) !== record.issuerCertSha256 ||
      client.ca ||
      !current(client) ||
      digest(client.raw) !== record.gatewayClientCertSha256 ||
      !client.checkIssued(issuer) ||
      !client.verify(issuer.publicKey) ||
      !client.keyUsage?.includes('1.3.6.1.5.5.7.3.2') ||
      typeof files['client.key'] !== 'string' ||
      Buffer.byteLength(files['client.key']) > 16384 ||
      !client.checkPrivateKey(parseManagedPrivateKey(files['client.key']))
    )
      throw refused();
    return files;
  } catch {
    throw refused();
  }
}
export function readGatewayTlsMaterial(directory, record) {
  return verifyGatewayTlsMaterial(
    record,
    readProtectedTlsMaterial(directory, [
      'issuer.pem',
      'client.pem',
      'client.key',
    ]),
  );
}
