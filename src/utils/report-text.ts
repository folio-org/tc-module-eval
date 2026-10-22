// Criterion details are report rows separated by newlines, and the HTML report reads structure from row
// text: indentation, "Key: value", "(evidence: ...)", "... N more" and a leading "path:line [tag]".
// Every value copied from the evaluated repository goes through one of these helpers so it stays inside
// its row and cannot pose as that syntax.
// Not covered: a value that starts a row (build output, a license name) can still begin with
// "path:line [tag]" or "Key:" and render as a lead, tag chip or key/value row. Its lead links only
// to a file the same criterion cites in its structured data.

const LINE_BREAK = /\r\n?|[\n\u000b\u000c\u0085\u2028\u2029]/g;
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;

/** Repository text for a report row: line breaks become " ↵ " and other control characters are escaped. */
export function reportText(value: string): string {
  const text = value
    .replace(LINE_BREAK, ' ↵ ')
    .replace(CONTROL, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/\(\s*evidence:/gi, '[evidence:');
  // A whole row reading "... N more" is the report's own overflow marker.
  return /^\s*\.\.\. \d+ more\s*$/.test(text) ? text.replace('...', '…') : text;
}

/**
 * A repository path for a report row. Characters other than letters, digits, ".", "_", "-" and "/" are
 * percent-encoded (UTF-8), so a file name cannot extend or fake the "path:line [tag]" a row starts with.
 * The HTML report decodes it to link the file.
 */
export function reportPath(path: string): string {
  return path.replace(/[^\w.\-/]/gu, character =>
    [...Buffer.from(character, 'utf8')].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''));
}
