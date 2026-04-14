import type { LogCompressor } from './types';
import { StructuredCompressor } from './structured';
import { NoopCompressor } from './noop';

export function createCompressor(type: string): LogCompressor {
  switch (type) {
    case 'structured':
      return new StructuredCompressor();
    case 'none':
      return new NoopCompressor();
    default:
      throw new Error(`Unknown compressor type: ${type}`);
  }
}
