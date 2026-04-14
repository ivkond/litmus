export interface CompressedLog {
  content: string;
  inputChars: number;
  outputChars: number;
}

export interface LogCompressor {
  readonly type: string;
  compress(rawLog: string, options: { maxChars: number }): CompressedLog;
}
