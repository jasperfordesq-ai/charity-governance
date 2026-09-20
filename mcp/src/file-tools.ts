import type { ApiClient } from './client.js';
import type { ConnectorConfig } from './config.js';
import type { ToolAnnotations } from './tools.js';
import { readUploadable, writeDownload, FileAccessError } from './files.js';
import { Buffer } from 'node:buffer';
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
  annotations: ToolAnnotations;
  /**
   * Which directory the operator must have named for this tool to exist.
   * `nothing` means it is always available: it neither reads from this machine
   * nor writes to it.
   */
  requires: 'uploadRoot' | 'downloadDir' | 'nothing';
}

/** The two text types CharityPilot accepts, and what to call the file. */
export const TEXT_UPLOAD_TYPES: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
};

/**
 * A ceiling far below the API's ten megabytes.
 *
 * This content was composed by a model rather than read from a file, and a
 * document that size is not a note: it is a sign something has gone wrong.
 */
export const TEXT_UPLOAD_MAX_BYTES = 64 * 1024;

export const FILE_TOOLS: readonly FileToolDefinition[] = [
  {
    name: 'document_upload',
    description:
      'Upload a file from this machine into the charity’s documents. Only files '
      + 'under the directory the connector was given may be read, and only the file '
      + 'types CharityPilot accepts.',
    level: 'write',
    requires: 'uploadRoot',
    annotations: {
      title: 'Document upload',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
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
    // A download writes a file onto the operator's machine, so it is not
    // read-only in the protocol's sense, though it changes nothing at the API.
    annotations: {
      title: 'Document download',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
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
  {
    name: 'report_export',
    description:
      'Save the charity’s compliance report for a year, as the web application exports it, '
      + 'into the directory the connector was given, and report where it was written. The '
      + 'report itself is never returned: it is the widest payload the API has, carrying the '
      + 'whole profile and every register.',
    level: 'write',
    requires: 'downloadDir',
    annotations: {
      title: 'Report export',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', minimum: 2000, maximum: 2200, description: 'Reporting year.' },
        reason: { type: 'string', maxLength: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'document_upload_text',
    description:
      'File a note or a table as an evidence document by giving its text here, for a client '
      + 'with no file system. Plain text or comma-separated values only, and far smaller than '
      + 'an uploaded file may be. Use document_upload for a file on this machine.',
    level: 'write',
    requires: 'nothing',
    annotations: {
      title: 'Document upload text',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 300, description: 'What to call it in CharityPilot.' },
        category: { type: 'string', enum: [...DOCUMENT_CATEGORIES] },
        format: { type: 'string', enum: Object.keys(TEXT_UPLOAD_TYPES) },
        content: {
          type: 'string',
          maxLength: TEXT_UPLOAD_MAX_BYTES,
          description: 'The document’s whole text.',
        },
        description: { type: 'string', maxLength: 1000 },
        reason: { type: 'string', maxLength: 500, description: 'Why it is being added.' },
      },
      required: ['name', 'category', 'format', 'content'],
      additionalProperties: false,
    },
  },
];

const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

/** A document name reduced to something that can only be a file name. */
function safeStem(name: string): string {
  const stem = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return stem || 'document';
}

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
  if (tool.requires === 'uploadRoot') {
    return 'Uploading is off. It reads files from this machine, so it is available only when '
      + 'the connector is started with --upload-root pointing at a directory you chose.';
  }
  if (tool.requires === 'downloadDir') {
    return 'Downloading is off. It writes a charity’s documents onto this machine, so it is '
      + 'available only when the connector is started with --download-dir pointing at a '
      + 'directory you chose.';
  }
  // Unreachable: a tool requiring nothing is never unavailable. Stated rather
  // than thrown so that adding a third directory cannot silently fall through.
  return `${tool.name} needs no directory and is always available.`;
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

  if (tool.name === 'document_upload_text') {
    const format = requiredString(args, 'format', 8);
    const mimeType = TEXT_UPLOAD_TYPES[format];
    if (!mimeType) {
      throw new FileAccessError(
        `format must be one of: ${Object.keys(TEXT_UPLOAD_TYPES).join(', ')}.`,
      );
    }

    // The ceiling is measured in bytes below, not characters, so no character
    // limit is imposed here: it would refuse first and say the wrong thing.
    const content = requiredString(args, 'content', Number.MAX_SAFE_INTEGER);
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > TEXT_UPLOAD_MAX_BYTES) {
      // Checked on the encoded length as well as the character count: one
      // accented character is two bytes, and the API counts bytes.
      throw new FileAccessError(
        `content must be ${TEXT_UPLOAD_MAX_BYTES / 1024} KB or less once encoded.`,
      );
    }

    const name = requiredString(args, 'name', 300);
    const fields: Record<string, string> = {
      name,
      category: requiredString(args, 'category', 64),
    };
    const description = optionalString(args, 'description', 1000);
    if (description) fields['description'] = description;

    const created = await client.upload<{ data?: { id?: string; name?: string } }>(
      '/api/v1/documents',
      // The file name is derived from the document name rather than taken from
      // the caller, so it cannot carry a path or an extension the API refuses.
      { name: `${safeStem(name)}.${format}`, mimeType, bytes },
      fields,
      { reason },
    );

    return {
      uploaded: {
        id: created.data?.id ?? null,
        name: created.data?.name ?? name,
        bytes: bytes.length,
        from: 'text supplied in the call',
      },
    };
  }

  if (!config.downloadDir) throw new FileAccessError(unavailableBecause(tool));

  if (tool.name === 'report_export') {
    const year = args['year'];
    if (year !== undefined && (typeof year !== 'number' || !Number.isInteger(year)
      || year < 2000 || year > 2200)) {
      throw new FileAccessError('year must be a whole number between 2000 and 2200.');
    }
    const query = year === undefined ? '' : `?year=${year}`;
    const { bytes, fileName } = await client.download(
      `/api/v1/export/compliance-report${query}`,
    );
    const written = writeDownload(
      config.downloadDir,
      fileName ?? `compliance-report${year === undefined ? '' : `-${year}`}.html`,
      bytes,
    );

    return {
      saved: { path: written.path, bytes: bytes.length, sha256: written.sha256 },
      note:
        'The report is on disk at the path above. Its contents were deliberately not '
        + 'returned here: it carries the whole organisation profile and every register.',
    };
  }

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
