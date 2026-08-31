import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workbenchScript = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('customer workbench automatically locks when the active CDK expires', () => {
  assert.match(workbenchScript, /function scheduleCdkExpiry\(details\)/);
  assert.match(workbenchScript, /if \(!scheduleCdkExpiry\(verification\)\)/);
  assert.match(workbenchScript, /function lockWorkbench[\s\S]*?clearCdkExpiryTimer\(\);/);
  assert.match(workbenchScript, /visibilitychange[\s\S]*?enforceCdkExpiry/);
  assert.match(workbenchScript, /当前 CDK 已过期，请输入新的 CDK 后继续使用/);
});
