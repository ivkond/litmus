import { describe, it, expect } from 'vitest';
import { parseCSV, serializeCSV } from '../csv';

describe('parseCSV', () => {
  it('parses header and data rows', () => {
    const csv = 'criterion,weight,description\nclarity,5,Is the output clear?\ncorrectness,10,Is it correct?';
    const result = parseCSV(csv);
    expect(result.headers).toEqual(['criterion', 'weight', 'description']);
    expect(result.rows).toEqual([
      ['clarity', '5', 'Is the output clear?'],
      ['correctness', '10', 'Is it correct?'],
    ]);
  });

  it('returns empty rows when CSV has only a header', () => {
    const csv = 'criterion,weight,description';
    const result = parseCSV(csv);
    expect(result.headers).toEqual(['criterion', 'weight', 'description']);
    expect(result.rows).toEqual([]);
  });

  it('returns default structure for empty string', () => {
    const result = parseCSV('');
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it('trims whitespace from cells', () => {
    const csv = ' name , score \n  Alice , 10  ';
    const result = parseCSV(csv);
    expect(result.headers).toEqual(['name', 'score']);
    expect(result.rows).toEqual([['Alice', '10']]);
  });

  it('handles quoted fields containing commas', () => {
    const csv = 'criterion,description\nstyle,"Clear, concise output"';
    const result = parseCSV(csv);
    expect(result.rows[0]).toEqual(['style', 'Clear, concise output']);
  });

  it('handles quoted fields containing newlines', () => {
    const csv = 'criterion,description\nstyle,"Line 1\nLine 2"';
    const result = parseCSV(csv);
    expect(result.rows[0]).toEqual(['style', 'Line 1\nLine 2']);
  });

  it('handles escaped quotes inside quoted fields', () => {
    const csv = 'criterion,description\nstyle,"Say ""hello"""';
    const result = parseCSV(csv);
    expect(result.rows[0]).toEqual(['style', 'Say "hello"']);
  });

  it('skips empty trailing lines', () => {
    const csv = 'a,b\n1,2\n\n';
    const result = parseCSV(csv);
    expect(result.rows).toEqual([['1', '2']]);
  });

  it('pads short rows with empty strings to match header length', () => {
    const csv = 'a,b,c\n1';
    const result = parseCSV(csv);
    expect(result.rows[0]).toEqual(['1', '', '']);
  });
});

describe('serializeCSV', () => {
  it('serializes headers and rows', () => {
    const result = serializeCSV(
      ['criterion', 'weight', 'description'],
      [
        ['clarity', '5', 'Is the output clear?'],
        ['correctness', '10', 'Is it correct?'],
      ],
    );
    expect(result).toBe('criterion,weight,description\nclarity,5,Is the output clear?\ncorrectness,10,Is it correct?');
  });

  it('quotes fields containing commas', () => {
    const result = serializeCSV(['a'], [['hello, world']]);
    expect(result).toBe('a\n"hello, world"');
  });

  it('quotes fields containing newlines', () => {
    const result = serializeCSV(['a'], [['line 1\nline 2']]);
    expect(result).toBe('a\n"line 1\nline 2"');
  });

  it('escapes double quotes inside fields', () => {
    const result = serializeCSV(['a'], [['say "hi"']]);
    expect(result).toBe('a\n"say ""hi"""');
  });

  it('round-trips through parseCSV', () => {
    const headers = ['criterion', 'weight', 'description'];
    const rows = [
      ['style', '5', 'Clear, concise output'],
      ['correctness', '10', 'Say "hello"'],
    ];
    const csv = serializeCSV(headers, rows);
    const parsed = parseCSV(csv);
    expect(parsed.headers).toEqual(headers);
    expect(parsed.rows).toEqual(rows);
  });
});
