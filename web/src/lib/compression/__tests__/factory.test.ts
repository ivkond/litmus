import { describe, it, expect } from 'vitest';
import { createCompressor } from '../factory';

describe('createCompressor', () => {
  it('creates structured compressor', () => {
    const c = createCompressor('structured');
    expect(c.type).toBe('structured');
  });

  it('creates noop compressor', () => {
    const c = createCompressor('none');
    expect(c.type).toBe('none');
  });

  it('noop returns input unchanged', () => {
    const c = createCompressor('none');
    const result = c.compress('hello world', { maxChars: 100 });
    expect(result.content).toBe('hello world');
    expect(result.inputChars).toBe(11);
    expect(result.outputChars).toBe(11);
  });

  it('throws on unknown type', () => {
    expect(() => createCompressor('unknown')).toThrow();
  });
});
