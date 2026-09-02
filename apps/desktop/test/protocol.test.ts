import { describe, it, expect, vi } from 'vitest';
import { join, resolve } from 'node:path';

// `protocol.ts` imports `electron` at module scope. Outside of an Electron process the
// `electron` package resolves to a CJS shim that default-exports the path to the binary,
// so the named imports would fail. `resolveUiPath` itself touches none of these APIs.
vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  net: { fetch: vi.fn() },
}));

const { resolveUiPath, injectScriptNonce, SCRIPT_NONCE_HEADER } = await import('../src/protocol.js');

const uiRoot = resolve('/srv/context-restorer/ui');

describe('resolveUiPath', () => {
  it('maps the root path to index.html', () => {
    expect(resolveUiPath(uiRoot, '/')).toBe(join(uiRoot, 'index.html'));
  });

  it('resolves a nested asset inside the root', () => {
    expect(resolveUiPath(uiRoot, '/assets/x.js')).toBe(join(uiRoot, 'assets', 'x.js'));
  });

  it('blocks a plain traversal', () => {
    expect(resolveUiPath(uiRoot, '/../../secrets')).toBeNull();
  });

  it('blocks a percent-encoded traversal', () => {
    expect(resolveUiPath(uiRoot, '/%2e%2e%2f%2e%2e%2fsecrets')).toBeNull();
  });
});

describe('injectScriptNonce', () => {
  it('adds the nonce to a bare inline <script> tag', () => {
    expect(injectScriptNonce('<script>1</script>', 'abc')).toBe(
      '<script nonce="abc">1</script>',
    );
  });

  it('adds the nonce to an inline <script> tag carrying other attributes', () => {
    expect(injectScriptNonce('<script type="module">1</script>', 'abc')).toBe(
      '<script nonce="abc" type="module">1</script>',
    );
  });

  it('leaves a <script src=…> tag untouched, regardless of attribute order', () => {
    const withSrc = '<script src="./a.js" async=""></script>';
    expect(injectScriptNonce(withSrc, 'abc')).toBe(withSrc);

    const srcNotFirst = '<script noModule="" src="./a.js"></script>';
    expect(injectScriptNonce(srcNotFirst, 'abc')).toBe(srcNotFirst);
  });

  it('nonces every inline script in a document while skipping every src one', () => {
    const html =
      '<script src="./a.js"></script><script>x()</script><script>y()</script>';
    expect(injectScriptNonce(html, 'n1')).toBe(
      '<script src="./a.js"></script><script nonce="n1">x()</script><script nonce="n1">y()</script>',
    );
  });
});

describe('SCRIPT_NONCE_HEADER', () => {
  it('is a lowercase header name', () => {
    expect(SCRIPT_NONCE_HEADER).toBe(SCRIPT_NONCE_HEADER.toLowerCase());
  });
});
