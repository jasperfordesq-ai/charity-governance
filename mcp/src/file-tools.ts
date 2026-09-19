import type { ApiClient } from './client.js';
import type { ConnectorConfig } from './config.js';
import { readUploadable, writeDownload, FileAccessError } from './files.js';
import { DOCUMENT_CATEGORIES } from './enums.js';

/**
 * The two tools that move files between this machine and the charity's records.
 *
 * Both are off unless the operator names a directory for them, and neither is
 * a read or a write of the kind the other tools do.
 *
 * An upload is a channel INTO the tenant, and onward to wherever documents are
 * mirrored. It matters where the file came from, which is why nothing outside
 * the named directory can be read, however the path is spelled.
 *
 * A download is personal data leaving the machine the API runs behind. The
 * field policy cannot filter a stored file: a PDF of board minutes is either
 * handed over whole or not at all. So the tool returns the path it wrote and
 * never the bytes, which keeps the contents out of the model's context even
 * when the file itself is on disk.
 */
export interface FileToolDefinition {
  name: string;
  description: string;
  level: 'write' | 'admin';
  inputSchema: object;
  /** Why the tool is unavailable when the operator has not enabled it. */
  requires: 'uploadRoot' | 'downloadDir';
}

export const FILE_TOOLS: readonly FileToolDefinition[] = [
  {
    name: 'document_upload',
    description:
      'Upload a file from this machine into the charity’s documents. Only files '
      + 'under the directory the connector was given may be read, and only the file '
      + 'types CharityPilot accepts.',
    level: 'write',
    requires: 'uploadRoot',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'The file to upload, relative to the directory the connector was given.',
        },
        name: { type: 'string', maxLength: 300, description: 'What to call it in CharityPilot.' },
        description: { type: 'string', maxLength: 1000 },
        category: { type: 'string', enum: [...DOCUMENT_CATEGORIES] },
        reason: { type: 'string', maxLength: 500, description: 'Why it is being added.' },
      },
      required: ['path', 'name', 'category'],
      additionalProperties: false,
    },
  },
  {
    name: 'document_download',
    description:
      'Save a stored document to the directory the connector was given, and report '
      + 'where it was written. The file itself is never returned, because a stored '
      + 'document cannot be filtered the way a record can.',
    level: 'write',
    requires: 'downloadDir',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifier as returned by documents_list.' },
        reason: { type: 'string', maxLength: 500 },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

function requiredString(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FileAccessError(`${name} is required.`);
  }
  if (value.length > max) throw new FileAccessError(`${name} must be ${max} characters or fewer.`);
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  name: string,
  max: number,
): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new FileAccessError(`${name} must be text.`);
  if (value.length > max) throw new FileAccessError(`${name} must be ${max} characters or fewer.`);
  return value;
}

export function unavailableBecause(tool: FileToolDefinition): string {
  return tool.requires === 'uploadRoot'
    ? 'Uploading is off. It reads files from this machine, so it is available only when '
      + 'the connector is started with --upload-root pointing at a directory you chose.'
    : 'Downloading is off. It writes a charity’s documents onto this machine, so it is '
      + 'available only when the connector is started with --download-dir pointing at a '
      + 'directory you chose.';
}

export async function runFileTool(
  tool: FileToolDefinition,
  client: ApiClient,
  config: ConnectorConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  for (const key of Object.keys(args)) {
    const declared = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    if (!(key in declared)) {
      throw new FileAccessError(
        `Unknown argument "${key}". This tool accepts: ${Object.keys(declared).join(', ')}.`,
      );
    }
  }

  const reason = optionalString(args, 'reason', 500);

  if (tool.name === 'document_upload') {
    if (!config.uploadRoot) throw new FileAccessError(unavailableBecause(tool));

    const file = readUploadable(config.uploadRoot, requiredString(args, 'path', 4096));
    const fields: Record<string, string> = {
      name: requiredString(args, 'name', 300),
      category: requiredString(args, 'category', 64),
    };
    const description = optionalString(args, 'description', 1000);
    if (description) fields['description'] = description;

    const created = await client.upload<{ data?: { id?: string; name?: string } }>(
      '/api/v1/documents',
      file,
      fields,
      { reason },
    );

    return {
      uploaded: {
        id: created.data?.id ?? null,
        name: created.data?.name ?? fields['name'],
        bytes: file.bytes.length,
        from: file.path,
      },
    };
  }

  if (!config.downloadDir) throw new FileAccessError(unavailableBecause(tool));

  const id = requiredString(args, 'id', 160);
  if (!ID_PATTERN.test(id)) {
    throw new FileAccessError(
      'id must be an identifier of letters, digits, hyphens or underscores.',
    );
  }

  const { bytes, fileName } = await client.download(`/api/v1/documents/${id}/download`);
  const written = writeDownload(config.downloadDir, fileName ?? `${id}.bin`, bytes);

  return {
    saved: {
      path: written.path,
      bytes: bytes.length,
      sha256: written.sha256,
    },
    note:
      'The file is on disk at the path above. Its contents were deliberately not '
      + 'returned here.',
  };
}
