// web/src/lib/judge/__tests__/redactor.test.ts
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../redactor';

describe('redactSecrets', () => {
  it('redacts OpenAI-style API keys', () => {
    expect(redactSecrets('key is sk-abc123def456')).toBe('key is [REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbG...')).toBe('Authorization: [REDACTED]');
  });

  it('redacts env var assignments', () => {
    expect(redactSecrets('export API_KEY=mysecretvalue123')).toBe('export API_KEY=[REDACTED]');
  });

  it('redacts multiple secrets in one string', () => {
    const input = 'sk-abc123 and Bearer xyz and TOKEN=secret';
    const result = redactSecrets(input);
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('xyz');
    expect(result).not.toContain('secret');
  });

  it('leaves non-secret text unchanged', () => {
    const input = 'Running test suite... 42 tests passed';
    expect(redactSecrets(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(redactSecrets('')).toBe('');
  });
});
