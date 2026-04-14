import { describe, it, expect } from 'vitest';
import { extractUrls, detectDeviceCode } from '../oauth-capture';

describe('extractUrls', () => {
  it('test_extractUrls_httpUrl_extracted', () => {
    const urls = extractUrls('Visit http://example.com/auth to login');
    expect(urls).toContain('http://example.com/auth');
  });

  it('test_extractUrls_httpsUrl_extracted', () => {
    const urls = extractUrls('Open https://github.com/login/device');
    expect(urls).toContain('https://github.com/login/device');
  });

  it('test_extractUrls_multipleUrls_allExtracted', () => {
    const urls = extractUrls('Go to https://a.com or https://b.com/path');
    expect(urls).toHaveLength(2);
  });

  it('test_extractUrls_noUrls_emptyArray', () => {
    const urls = extractUrls('No URLs here');
    expect(urls).toEqual([]);
  });

  it('test_extractUrls_urlWithQueryParams_extracted', () => {
    const urls = extractUrls('https://login.example.com/authorize?code=abc&state=xyz');
    expect(urls[0]).toBe('https://login.example.com/authorize?code=abc&state=xyz');
  });

  it('test_extractUrls_urlInQuotes_extracted', () => {
    const urls = extractUrls('Open "https://example.com/auth"');
    expect(urls[0]).toBe('https://example.com/auth');
  });
});

describe('detectDeviceCode', () => {
  it('test_detectDeviceCode_codeInContext_extracted', () => {
    const lines = [
      'Opening browser...',
      'Enter this code: ABCD-1234',
      'Waiting for authentication...',
    ];
    const code = detectDeviceCode(lines, 1);
    expect(code).toBe('ABCD-1234');
  });

  it('test_detectDeviceCode_codeKeywordNearby_extracted', () => {
    const lines = [
      'Device code: XY12-AB34',
      'Visit https://github.com/login/device',
      'Enter the code above',
    ];
    const code = detectDeviceCode(lines, 1);
    expect(code).toBe('XY12-AB34');
  });

  it('test_detectDeviceCode_noCode_returnsNull', () => {
    const lines = ['Just some random output', 'Nothing here'];
    const code = detectDeviceCode(lines, 0);
    expect(code).toBeNull();
  });

  it('test_detectDeviceCode_onlyUrlLine_noCode', () => {
    const lines = ['Open https://example.com'];
    const code = detectDeviceCode(lines, 0);
    expect(code).toBeNull();
  });
});