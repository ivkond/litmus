export interface ParsedCSV {
  headers: string[];
  rows: string[][];
}

/**
 * Parse a CSV string into headers and data rows.
 * Supports quoted fields (commas, newlines, escaped quotes inside).
 */
export function parseCSV(csv: string): ParsedCSV {
  const trimmed = csv.trim();
  if (!trimmed) return { headers: [], rows: [] };

  const lines = splitCSVLines(trimmed);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = splitCSVRow(lines[0]).map((h) => h.trim());
  const rows: string[][] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue; // skip empty lines
    const cells = splitCSVRow(line).map((c) => c.trim());
    // Pad short rows to match header length
    while (cells.length < headers.length) cells.push('');
    rows.push(cells);
  }

  return { headers, rows };
}

/**
 * Serialize headers + rows into a CSV string.
 * Quotes fields containing commas, newlines, or double quotes.
 */
export function serializeCSV(headers: string[], rows: string[][]): string {
  const lines = [headers.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeField).join(','));
  }
  return lines.join('\n');
}

// --- internal helpers ---

function escapeField(field: string): string {
  if (field.includes(',') || field.includes('\n') || field.includes('"')) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

/**
 * Split CSV text into logical lines, respecting quoted fields that span
 * multiple physical lines.
 */
function splitCSVLines(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip \r (handle \r\n)
      continue;
    } else {
      current += ch;
    }
  }

  if (current) lines.push(current);
  return lines;
}

/**
 * Split a single CSV line into fields, handling quoted values.
 */
function splitCSVRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ""
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip next quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }

  fields.push(current);
  return fields;
}
