import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = process.cwd();
const annualArticle = readFileSync(
  join(WEB, 'src', 'content', 'blog', 'annual-reporting-guide-irish-charities.tsx'),
  'utf8',
);
const blogArticles = [
  'annual-reporting-guide-irish-charities.tsx',
  'essential-trustee-policies.tsx',
  'simple-vs-complex-charity-classification.tsx',
  'understanding-the-charities-governance-code.tsx',
].map((file) =>
  readFileSync(join(WEB, 'src', 'content', 'blog', file), 'utf8'),
).join('\n');
const sourceLog = readFileSync(
  join(WEB, '..', '..', 'docs', 'product-revamp', 'irish-source-log.md'),
  'utf8',
);

test('annual-reporting guide cannot restore the unsupported income-band table', () => {
  for (const unsafeClaim of [
    /€10,000\s*[–-]\s*€100,000/i,
    /€100,000\s*[–-]\s*€250,000/i,
    /€250,000\s*[–-]\s*€500,000/i,
    /€500,000 audit threshold/i,
    /full statutory audit by a registered auditor required/i,
    /independent examination by a qualified person mandatory/i,
    /independent examiner must be a person with relevant financial/i,
  ]) {
    assert.doesNotMatch(blogArticles, unsafeClaim);
  }

  for (const unsafeCrossArticleClaim of [
    /Charities \(Accounts and Audit\) Regulations/i,
    /income above €100,000/i,
    /charities above the relevant threshold[\s\S]{0,100}independent audit/i,
    /€(?:100,000|250,000|500,000)[\s\S]{0,100}(?:audit threshold|independent examin)/i,
  ]) {
    assert.doesNotMatch(blogArticles, unsafeCrossArticleClaim);
  }

  assert.match(annualArticle, /does not publish an income-band table/i);
  assert.match(annualArticle, /Do not infer an audit, examination, or accounts requirement from income alone/i);
  assert.doesNotMatch(annualArticle, /irishstatutebook\.ie\/[^'"\s]+\/enacted\//i);
});

test('annual-reporting guide shows dated primary sources and limitations', () => {
  for (const requiredCopy of [
    'Last checked: 10 July 2026',
    'not legal or accounting advice',
    'accountant',
    'solicitor',
    'legal form',
    'not yet commenced',
    'explicitly described as proposed',
    'Professional review status',
  ]) {
    assert.ok(annualArticle.includes(requiredCopy), `article must include ${requiredCopy}`);
  }

  for (const officialUrl of [
    'https://www.charitiesregulator.ie/en/information-for-charities/annual-report-how-to-submit',
    'https://www.charitiesregulator.ie/media/1501/annual-report-user-guide-revised-2-august.pdf',
    'https://www.charitiesregulator.ie/media/2329/annual-reporting-information-note-final.pdf',
    'https://revisedacts.lawreform.ie/eli/2009/act/6/section/48/revised/en/html',
    'https://revisedacts.lawreform.ie/eli/2009/act/6/section/50/revised/en/html',
    'https://revisedacts.lawreform.ie/eli/2009/act/6/section/52/revised/en/html',
    'https://www.irishstatutebook.ie/eli/2009/act/isbc/2009_6.html',
    'https://www.irishstatutebook.ie/eli/isbc/2024_21.html',
    'https://www.charitiesregulator.ie/media/4569/guidance-on-charities-sorp.pdf',
    'https://cro.ie/annual-return/financial-statements-requirements/',
    'https://cro.ie/annual-return/financial-statements-requirements/audit-exemption/',
  ]) {
    assert.ok(annualArticle.includes(officialUrl), `article must link ${officialUrl}`);
    assert.ok(sourceLog.includes(officialUrl), `source log must record ${officialUrl}`);
  }
});

test('annual-reporting source log agrees with the visible commencement warning', () => {
  assert.match(sourceLog, /^Date checked: 2026-07-09$/m);
  assert.match(sourceLog, /^Last updated: 2026-07-12 \(targeted legislation\/CRO link and currency recheck\)$/m);
  assert.match(sourceLog, /Annual accounting and audit status check[\s\S]*2026-07-10/);
  assert.match(sourceLog, /sections 17 to 19[\s\S]*not yet commenced/i);
  assert.match(sourceLog, /does not list an instrument made under section 50/i);
  assert.match(sourceLog, /proposed Charities SORP regime/i);
  assert.match(sourceLog, /accountant and solicitor approval remains external/i);
});
