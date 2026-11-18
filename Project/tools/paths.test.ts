import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { backendRoot, privateOutputPath } from './paths.js';

test('personal import reports stay outside tracked repository paths', () => {
  assert.equal(privateOutputPath('.local/imports/report.json'), resolve(backendRoot, '.local/imports/report.json'));
  const external = resolve(backendRoot, '../..', 'private-data', 'report.json');
  assert.equal(privateOutputPath(external), external);
  for (const path of ['src/report.json', 'data/report.json', '.local/../report.json', '.', '.local', '../report.json', resolve(backendRoot, '../Docs/report.json'), resolve(backendRoot, '../Docker/report.json')]) {
    assert.throws(() => privateOutputPath(path));
  }
});
