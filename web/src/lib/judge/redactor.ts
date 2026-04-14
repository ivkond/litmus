// web/src/lib/judge/redactor.ts

type PatternEntry = { pattern: RegExp; replacement: string };

const PATTERN_ENTRIES: PatternEntry[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{6,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bBearer\s+\S+/g, replacement: '[REDACTED]' },
  {
    pattern: /\b([A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS))=[^\s\n]+/g,
    replacement: '$1=[REDACTED]',
  },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: '[REDACTED]' },
  { pattern: /\b[A-Za-z0-9+\/]{64,}={0,2}\b/g, replacement: '[REDACTED]' },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of PATTERN_ENTRIES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
