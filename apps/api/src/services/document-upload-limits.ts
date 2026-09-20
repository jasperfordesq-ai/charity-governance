/**
 * How large a governance document may be.
 *
 * A SERVICE-LAYER MODULE, AND THAT IS THE WHOLE POINT OF IT EXISTING. This
 * constant used to live in `routes/documents/document-upload-validation.ts`,
 * and `services/confluence-attachments.ts` imported it from there — a service
 * reaching up into the route layer for a fact that is not about HTTP at all.
 *
 * It is not a tidiness complaint. The bound is a property of the domain: the
 * largest file CharityPilot will hold, and therefore the largest it can ever
 * mirror to Confluence. Two layers agreeing on it matters, because a Confluence
 * attachment bound *smaller* than the upload bound would let a charity store a
 * document the mirror could never carry, and a bound *larger* would let the
 * publisher attempt an upload Atlassian refuses. Sourcing both from one
 * service-layer constant is what keeps them from drifting, and putting it where
 * the route layer is the importer rather than the imported is what stops a
 * background job's dependency graph reaching into `routes/`.
 *
 * `document-upload-validation.ts` re-exports it, so every existing import site
 * keeps working and nothing has to be chased down.
 */

/** 10 MB. */
export const DOCUMENT_UPLOAD_MAX_FILE_SIZE = 10 * 1024 * 1024;
