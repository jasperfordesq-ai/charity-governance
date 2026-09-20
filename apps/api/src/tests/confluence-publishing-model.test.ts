import assert from 'node:assert/strict';
import test from 'node:test';
import {
  categoryPrefix,
  publicationLabels,
  readPublishingModel,
  DEFAULT_PUBLISHING_MODEL,
} from '../services/confluence-publishing-model.js';

/**
 * The property that makes it safe to ship these options before the
 * owner/DPO publishing-model conversation: a charity that has configured
 * nothing behaves exactly as it did before the options existed.
 */

test('an unconfigured organisation gets exactly the behaviour it had before', () => {
  for (const config of [null, undefined, {}, { siteId: 'site-1' }, [], 'nonsense', 42]) {
    assert.deepEqual(
      readPublishingModel(config),
      DEFAULT_PUBLISHING_MODEL,
      `for ${JSON.stringify(config ?? null)}`,
    );
  }
});

test('the defaults are the current behaviour, field for field', () => {
  // Spelled out rather than compared to itself. Changing any of these changes
  // what every existing charity's pages look like, which is the decision this
  // module exists to keep out of the code.
  assert.deepEqual(DEFAULT_PUBLISHING_MODEL, {
    naming: 'DOCUMENT_NAME',
    bodyMode: 'STUB_WITH_ATTACHMENT',
    parentPageId: null,
    applyLabels: false,
    mirrorContentState: false,
    classificationLabel: null,
  });
});

test('a malformed setting falls back to the default rather than throwing', () => {
  const model = readPublishingModel({ naming: 'SOMETHING_ELSE', bodyMode: 17, parentPageId: 42 });

  // It can only fail towards what the product already did. A malformed setting
  // must never stop a charity's documents publishing.
  assert.equal(model.naming, 'DOCUMENT_NAME');
  assert.equal(model.bodyMode, 'STUB_WITH_ATTACHMENT');
  assert.equal(model.parentPageId, null);
});

test('the booleans are true only when literally true', () => {
  const model = readPublishingModel({ applyLabels: 'yes', mirrorContentState: 1 });

  // A truthy string must not switch on a behaviour that writes to a charity's
  // Confluence site.
  assert.equal(model.applyLabels, false);
  assert.equal(model.mirrorContentState, false);
});

test('a fully configured model is read whole', () => {
  const model = readPublishingModel({
    naming: 'CATEGORY_PREFIXED',
    bodyMode: 'FULL_BODY',
    parentPageId: '12345',
    applyLabels: true,
    mirrorContentState: true,
    classificationLabel: 'internal',
  });

  assert.deepEqual(model, {
    naming: 'CATEGORY_PREFIXED',
    bodyMode: 'FULL_BODY',
    parentPageId: '12345',
    applyLabels: true,
    mirrorContentState: true,
    classificationLabel: 'internal',
  });
});

test('a classification label that is not a Confluence label is dropped', () => {
  for (const value of ['Internal Only', 'UPPER', 'has spaces', '-leading', 'x'.repeat(80)]) {
    assert.equal(
      readPublishingModel({ classificationLabel: value }).classificationLabel,
      null,
      `for ${value}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The naming convention
// ---------------------------------------------------------------------------

test('only the two reported prefixes exist, and nothing else is guessed at', () => {
  assert.equal(categoryPrefix('POLICY'), 'POL');
  assert.equal(categoryPrefix('PROCEDURE'), 'NOS');

  // A category with no confirmed prefix publishes under its own name. A page
  // that looks native and is subtly wrong is worse than one that is obviously
  // ours, and the POL-/NOS- convention has never been seen against a real site.
  for (const category of ['MINUTES', 'ACCOUNTS', 'OTHER', 'GOVERNING_DOCUMENT']) {
    assert.equal(categoryPrefix(category), null, `for ${category}`);
  }
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test('labels are off by default, so no existing page gains one', () => {
  assert.deepEqual(publicationLabels(DEFAULT_PUBLISHING_MODEL, { category: 'POLICY' }), []);
});

test('charitypilot is always the first label when labels are on', () => {
  const labels = publicationLabels(
    { ...DEFAULT_PUBLISHING_MODEL, applyLabels: true },
    { category: 'POLICY' },
  );

  // A space administrator asking "what did this tool create in my site" must
  // be able to answer it with one filter. That is the whole reason labels are
  // worth applying at all.
  assert.equal(labels[0], 'charitypilot');
  assert.deepEqual(labels, ['charitypilot', 'policy']);
});

test('a classification label rides along when one is configured', () => {
  assert.deepEqual(
    publicationLabels(
      { ...DEFAULT_PUBLISHING_MODEL, applyLabels: true, classificationLabel: 'internal' },
      { category: 'MINUTES' },
    ),
    ['charitypilot', 'minutes', 'internal'],
  );
});

test('a category that cannot be a Confluence label is dropped, not mangled onto the page', () => {
  const labels = publicationLabels(
    { ...DEFAULT_PUBLISHING_MODEL, applyLabels: true },
    { category: '???' },
  );

  assert.deepEqual(labels, ['charitypilot']);
});

test('duplicate labels collapse', () => {
  assert.deepEqual(
    publicationLabels(
      { ...DEFAULT_PUBLISHING_MODEL, applyLabels: true, classificationLabel: 'policy' },
      { category: 'POLICY' },
    ),
    ['charitypilot', 'policy'],
  );
});
