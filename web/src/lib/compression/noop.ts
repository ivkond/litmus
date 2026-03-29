import type { LogCompressor, CompressedLog } from './types';

export class NoopCompressor implements LogCompressor {
  readonly type = 'none';

  compress(rawLog: string, options: { maxChars: number }): CompressedLog {
    const content = rawLog.length > options.maxChars
      ? rawLog.slice(0, options.maxChars)
      : rawLog;
    return {
      content,
      inputChars: rawLog.length,
      outputChars: content.length,
    };
  }
}
