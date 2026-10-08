import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const client = await readFile(new URL('../client.js', import.meta.url), 'utf8');

test('wizard exposes request failures instead of hiding them behind early returns', () => {
  assert.match(client, /const errorNotice = error && e\('div', \{ className: 'nac-alert', role: 'alert' \}, error\)/);
  assert.ok((client.match(/nac-page nac-wizard' }, errorNotice/g) || []).length >= 5);
});

test('copy failures have visible manual-copy recovery feedback', () => {
  assert.match(client, /catch \{ setFailed\(true\); \}/);
  assert.match(client, /复制失败，请手动选择并复制内容/);
});

test('host member removal UI requires confirmation and calls the existing removal route', () => {
  assert.match(client, /移除此成员将轮换协作密钥/);
  assert.match(client, /call\('\/members\/remove', \{ memberId \}\)/);
  assert.match(client, /移除成员/);
});

test('join approval options are used in both wizard and dashboard paths', () => {
  assert.ok((client.match(/approvalFields/g) || []).length >= 3);
  assert.match(client, /duration, permissionLevel/);
});

test('automatic pairing exposes every connection stage without Grant JSON in default flow', () => {
  for (const stage of ['connecting', 'request-sent', 'awaiting-approval', 'grant-received', 'transport-connecting', 'connected', 'error', 'expired']) assert.match(client, new RegExp(stage));
  assert.match(client, /call\('\/join\/request', \{ invite: payload\.invitation, pairCode: pairCode\.trim\(\) \}\)/);
  assert.doesNotMatch(client, /const manualPublic = selectedNetwork/);
  assert.match(client, /高级手工 fallback：申请包/);
});

test('default onboarding uses plain-language connection actions', () => {
  assert.match(client, /开始协作（局域网）/);
  assert.match(client, /生成邀请和配对码/);
  assert.match(client, /允许加入/);
  assert.match(client, /粘贴邀请链接/);
  assert.doesNotMatch(client, /同意加入|同意接入/);
});

test('dashboard permission controls stay behind advanced settings', () => {
  assert.match(client, /高级设置/);
  assert.ok((client.match(/advancedOpen && approvalFields/g) || []).length >= 2);
  assert.match(client, /收起高级设置/);
});

const uiStyles = [...client.matchAll(/const extraStyle = '([^']*)'|style\.textContent = `([\s\S]*?)`|responsive\.textContent = '([^']*)'/g)]
  .map(([, singleQuoted, template, responsive]) => singleQuoted ?? template ?? responsive)
  .join('\n');
const responsiveStyles = client.match(/responsive\.textContent = '([^']*)'/)?.[1] ?? '';

function extractCssBlock(css, start) {
  const open = css.indexOf('{', start);
  assert.notEqual(open, -1, 'CSS block must open');
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}' && --depth === 0) return css.slice(open + 1, index);
  }
  assert.fail('CSS block must close');
}

function extractMediaQuery(css, query) {
  const start = css.indexOf(`@media ${query}`);
  assert.notEqual(start, -1, `Expected media query ${query}`);
  return extractCssBlock(css, start);
}

test('surface, typography, borders, controls, and focus use theme aliases', () => {
  assert.match(uiStyles, /--nac-canvas:var\(--dsw-alias-bg-base\)/);
  assert.match(uiStyles, /--nac-canvas-alt:var\(--dsw-alias-bg-layer-1\)/);
  assert.match(uiStyles, /--nac-ink:var\(--dsw-alias-label-primary\)/);
  assert.match(uiStyles, /--nac-ink-muted:var\(--dsw-alias-label-secondary\)/);
  assert.match(uiStyles, /--nac-hairline:var\(--dsw-alias-border-l1\)/);
  assert.match(uiStyles, /\.nac-button-primary\{background:var\(--dsw-alias-button-primary-fill\);color:var\(--dsw-alias-label-primary-foreground\)/);
  assert.match(uiStyles, /\.nac-button-secondary\{background:var\(--dsw-alias-bg-layer-1\);color:var\(--dsw-alias-label-primary\)/);
  assert.match(uiStyles, /\.nac-button-danger\{background:var\(--dsw-alias-state-error-primary\)/);
  assert.match(uiStyles, /:focus-visible\{outline:3px solid var\(--dsw-alias-link\)/);
  assert.doesNotMatch(uiStyles, /#[\da-f]{3,8}\b|rgba?\(/i);
});

test('success, warning, and error states use distinct valid theme aliases', () => {
  assert.match(uiStyles, /\.nac-status-ok\{border-color:var\(--dsw-alias-state-success-primary\)\}/);
  assert.match(uiStyles, /\.nac-status-ok strong\{color:var\(--dsw-alias-state-success-primary\)\}/);
  assert.match(uiStyles, /\.nac-status-wait\{border-color:var\(--dsw-alias-state-warn-primary\)\}/);
  assert.match(uiStyles, /\.nac-status-wait strong\{color:var\(--dsw-alias-state-warn-primary\)\}/);
  assert.match(uiStyles, /\.nac-alert\{[^}]*border-inline-start:3px solid var\(--dsw-alias-state-error-primary\)/);
  assert.match(uiStyles, /\.nac-priority\{border-color:var\(--dsw-alias-state-error-primary\)\}/);
  assert.doesNotMatch(client, /--dsw-alias-state-warning-primary/);
});

test('minimal dashboard hierarchy uses restrained type, spacing, and card treatment', () => {
  assert.match(uiStyles, /\.nac-header h1\{[^}]*font-size:30px;[^}]*font-weight:400/);
  assert.match(uiStyles, /\.nac-card h2\{[^}]*font-size:20px/);
  assert.match(uiStyles, /\.nac-card,\.nac-stat\{[^}]*padding:18px;margin:16px 0/);
  assert.match(uiStyles, /\.nac-button\.nac-button-primary\{[^}]*border-radius:8px/);
  assert.match(uiStyles, /\.nac-button\.nac-button-secondary\{[^}]*border-radius:8px/);
  assert.doesNotMatch(uiStyles, /border-radius:980px|box-shadow:|backdrop-filter:|linear-gradient\(/i);
});

test('wizard, approval, forms, and compact layouts remain represented', () => {
  assert.match(client, /className: 'nac-progress'/);
  assert.match(client, /className: 'nac-approval-fields'/);
  assert.match(client, /className: 'nac-grid nac-dashboard-primary'/);
  assert.match(client, /className: 'nac-grid nac-dashboard-secondary'/);
  assert.match(uiStyles, /@media \(max-width: 768px\)/);
  assert.match(uiStyles, /\.nac-grid\{grid-template-columns:minmax\(0,1fr\)!important\}/);
  assert.match(uiStyles, /\.nac-button\{width:100%\}/);
  assert.match(uiStyles, /@media \(max-width: 360px\)/);
});

test('approval fields stack within 480px and controls fill the narrow layout', () => {
  const approvalMedia = extractMediaQuery(responsiveStyles, '(max-width: 480px)');
  const approvalRule = approvalMedia.match(/\.nac-approval-fields\s*\{([^}]*)\}/)?.[1];
  assert.ok(approvalRule, '480px media query must include approval field rule');
  assert.match(approvalRule, /(?:^|;)\s*grid-template-columns\s*:\s*1fr\s*(?:;|$)/);
  assert.match(uiStyles, /\.nac-approval-fields select\{width:100%/);
  assert.match(extractMediaQuery(responsiveStyles, '(max-width: 768px)'), /\.nac-button\{width:100%\}/);
});
