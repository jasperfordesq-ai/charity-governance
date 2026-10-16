import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
export function tlsCertificateIsCurrent(cert) {
  const now = Date.now();
  return Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo);
}
export function tlsCertificateDigest(cert) {
  return createHash("sha256").update(cert.raw).digest("hex");
}
export function validateManagedTlsIdentity(
  material,
  issuerDigest,
  leafDigest,
  purpose,
  hostname,
) {
  try {
    const certificate = (pem) => {
      if (
        typeof pem !== "string" ||
        Buffer.byteLength(pem) > 16384 ||
        (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1
      )
        throw Error();
      return new X509Certificate(pem);
    };
    const issuer = certificate(material.issuerCertPem),
      leaf = certificate(material.certPem);
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
        purpose === "server" ? "1.3.6.1.5.5.7.3.1" : "1.3.6.1.5.5.7.3.2",
      ) ||
      !["server", "client"].includes(purpose) ||
      typeof material.keyPem !== "string" ||
      Buffer.byteLength(material.keyPem) > 16384 ||
      !leaf.checkPrivateKey(createPrivateKey(material.keyPem))
    )
      throw Error();
    if (
      purpose === "server" &&
      (typeof hostname !== "string" ||
        leaf.checkHost(hostname, {
          subject: "never",
          wildcards: false,
          partialWildcards: false,
          multiLabelWildcards: false,
        }) !== hostname)
    )
      throw Error();
    return { issuer, leaf };
  } catch {
    throw new Error("Managed TLS identity refused");
  }
}
