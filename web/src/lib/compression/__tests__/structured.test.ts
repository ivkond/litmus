import { describe, it, expect } from 'vitest';
import { StructuredCompressor } from '../structured';

describe('StructuredCompressor', () => {
  const compressor = new StructuredCompressor();

  it('has type "structured"', () => {
    expect(compressor.type).toBe('structured');
  });

  it('preserves chronological order of blocks', () => {
    const log = [
      '[2026-03-28 10:00:00] <thinking>First thought</thinking>',
      '[2026-03-28 10:00:01] tool_use: read_file args: {"path": "test.ts"}',
      '[2026-03-28 10:00:02] Error: something went wrong',
      '[2026-03-28 10:00:03] <thinking>Second thought</thinking>',
    ].join('\n');

    const result = compressor.compress(log, { maxChars: 50000 });
    const lines = result.content.split('\n');
    const timestamps = lines
      .filter((l) => l.includes('[2026-03-28'))
      .map((l) => l.match(/\[([^\]]+)\]/)?.[1])
      .filter(Boolean);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]! >= timestamps[i - 1]!).toBe(true);
    }
  });

  it('keeps ERROR blocks in full', () => {
    const errorLine = 'Error: TypeError: Cannot read properties of undefined';
    const log = `[10:00:00] Some normal output\n[10:00:01] ${errorLine}\n[10:00:02] More output`;
    const result = compressor.compress(log, { maxChars: 50000 });
    expect(result.content).toContain(errorLine);
  });

  it('truncates large TOOL_RESULT blocks', () => {
    const longResult = 'x'.repeat(1000);
    const log = `[10:00:00] tool_use: read_file\n[10:00:01] Result: ${longResult}\n[10:00:02] Done`;
    const result = compressor.compress(log, { maxChars: 50000 });
    expect(result.outputChars).toBeLessThan(result.inputChars);
  });

  it('reports compression ratio', () => {
    const log = 'x'.repeat(10000);
    const result = compressor.compress(log, { maxChars: 5000 });
    expect(result.inputChars).toBe(10000);
    expect(result.outputChars).toBeLessThanOrEqual(5000);
  });

  it('handles empty log', () => {
    const result = compressor.compress('', { maxChars: 50000 });
    expect(result.content).toBe('');
    expect(result.inputChars).toBe(0);
    expect(result.outputChars).toBe(0);
  });

  it('respects maxChars limit', () => {
    const log = Array.from({ length: 100 }, (_, i) =>
      `[10:${String(i).padStart(2, '0')}:00] ${'content '.repeat(50)}`
    ).join('\n');
    const result = compressor.compress(log, { maxChars: 2000 });
    expect(result.outputChars).toBeLessThanOrEqual(2000);
  });
});
