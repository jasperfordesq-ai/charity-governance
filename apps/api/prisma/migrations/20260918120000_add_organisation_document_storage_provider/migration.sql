ALTER TABLE "Organisation" ADD COLUMN "documentStorageProvider" TEXT;
ALTER TABLE "Organisation" ADD COLUMN "documentStorageAlphaOptIn" BOOLEAN NOT NULL DEFAULT false;
