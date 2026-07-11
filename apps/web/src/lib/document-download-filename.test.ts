import assert from 'node:assert/strict';
import test from 'node:test';
import { documentDownloadFilename } from './document-download-filename';

test('document download filenames preserve both valid JPEG suffixes', () => {
  assert.equal(documentDownloadFilename({ name: 'board-photo.jpg', mimeType: 'image/jpeg' }), 'board-photo.jpg');
  assert.equal(documentDownloadFilename({ name: 'board-photo.jpeg', mimeType: 'image/jpeg' }), 'board-photo.jpeg');
  assert.equal(documentDownloadFilename({ name: 'board-photo', mimeType: 'image/jpeg' }), 'board-photo.jpg');
});

test('document download filenames remove unsafe characters and preserve known suffixes', () => {
  assert.equal(documentDownloadFilename({ name: '../Board: Minutes.PDF', mimeType: 'application/pdf' }), '-Board- Minutes.PDF');
  assert.equal(documentDownloadFilename({ name: '   ', mimeType: 'text/plain' }), 'document.txt');
});
