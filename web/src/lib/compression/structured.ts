import type { LogCompressor, CompressedLog } from './types';

type BlockType = 'THINKING' | 'TOOL_CALL' | 'TOOL_RESULT' | 'CODE' | 'ERROR' | 'OTHER';

interface Block {
  index: number;
  timestamp: string | null;
  type: BlockType;
  content: string;
}

const ERROR_KEYWORDS = /\b(error|exception|traceback|fail|panic|fatal)\b/i;

const BLOCK_PATTERNS: [BlockType, RegExp][] = [
  ['THINKING', /^.*<thinking>|^>\s*thinking|^##\s*Reasoning/i],
  ['TOOL_CALL', /^.*tool_use:|^>\s*file edit|^##\s*Tool:|function_call|"tool"/i],
  ['ERROR', /^.*(Error:|ERROR|FAILED|exception|traceback|panic)/i],
  ['CODE', /^```|^diff\s|^\+\+\+|^---\s/],
];

function classifyLine(line: string): BlockType {
  for (const [type, pattern] of BLOCK_PATTERNS) {
    if (pattern.test(line)) return type;
  }
  return 'OTHER';
}

function extractTimestamp(line: string): string | null {
  const match = line.match(/\[([^\]]*\d{2}:\d{2}[^\]]*)\]/);
  return match ? match[1] : null;
}

function truncateBlock(block: Block, isLast: boolean): string {
  const { content, type } = block;

  switch (type) {
    case 'ERROR':
      return content;
    case 'TOOL_CALL':
      return content;
    case 'TOOL_RESULT':
      if (content.length <= 500) return content;
      return (
        content.slice(0, 200) +
        `\n── [compressed: ${content.length} → 400 chars] ──\n` +
        content.slice(-200)
      );
    case 'CODE':
      if (isLast) return content;
      {
        const lines = content.split('\n');
        if (lines.length <= 10) return content;
        return lines.slice(0, 10).join('\n') + `\n... [${lines.length - 10} lines omitted]`;
      }
    case 'THINKING':
      if (content.length <= 200) return content;
      return content.slice(0, 200) + `\n── [compressed: ${content.length} → 200 chars] ──`;
    case 'OTHER':
      if (ERROR_KEYWORDS.test(content)) return content;
      if (content.length <= 200) return content;
      return content.slice(0, 200) + `\n── [compressed: ${content.length} → 200 chars] ──`;
  }
}

export class StructuredCompressor implements LogCompressor {
  readonly type = 'structured';

  compress(rawLog: string, options: { maxChars: number }): CompressedLog {
    if (!rawLog) {
      return { content: '', inputChars: 0, outputChars: 0 };
    }

    const inputChars = rawLog.length;
    const lines = rawLog.split('\n');

    const blocks: Block[] = lines.map((line, i) => ({
      index: i,
      timestamp: extractTimestamp(line),
      type: classifyLine(line),
      content: line,
    }));

    let lastCodeIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === 'CODE') {
        lastCodeIdx = i;
        break;
      }
    }

    const compressed = blocks.map((block) =>
      truncateBlock(block, block.index === lastCodeIdx)
    );

    let result = compressed.join('\n');
    if (result.length > options.maxChars) {
      const half = Math.floor(options.maxChars / 2) - 50;
      result =
        result.slice(0, half) +
        `\n\n── [truncated: ${result.length} → ${options.maxChars} chars] ──\n\n` +
        result.slice(-half);
    }

    return {
      content: result,
      inputChars,
      outputChars: result.length,
    };
  }
}
