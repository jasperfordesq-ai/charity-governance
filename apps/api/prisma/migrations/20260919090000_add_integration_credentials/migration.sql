CREATE TYPE "IntegrationProvider" AS ENUM ('CONFLUENCE');
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR');

CREATE TABLE "OrganisationIntegration" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "config" JSONB,
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3),
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganisationIntegration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationCredential" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sealed" JSONB NOT NULL,
    "generation" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationSecretControl" (
    "id" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "activeKeyFingerprint" CHAR(64),
    "retiredKeyFingerprint" CHAR(64),
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntegrationSecretControl_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganisationIntegration_organisationId_provider_key" ON "OrganisationIntegration"("organisationId", "provider");
CREATE INDEX "OrganisationIntegration_organisationId_idx" ON "OrganisationIntegration"("organisationId");
CREATE UNIQUE INDEX "IntegrationCredential_integrationId_kind_key" ON "IntegrationCredential"("integrationId", "kind");
CREATE INDEX "IntegrationCredential_generation_idx" ON "IntegrationCredential"("generation");

ALTER TABLE "OrganisationIntegration" ADD CONSTRAINT "OrganisationIntegration_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "OrganisationIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
