/**
 * Decode a note's bytes into text, honouring what the file says about itself.
 *
 * Every note used to be read with `readFile(path, 'utf8')`, whatever it was.
 * A UTF-16 file — what Notepad and PowerShell's `>` write by default — became
 * U+FFFD soup: measured, a note whose first bytes were FF FE indexed with the
 * title 'utf16', a first block of EF BF BD EF BF BD 23 ..., and not one of its
 * words searchable, while `lore index` reported no warning at all. A Latin-1
 * file lost every accented word the same way.
 *
 * A byte-order mark is the file stating its encoding, so it is obeyed:
 * FF FE → UTF-16LE, FE FF → UTF-16BE, EF BB BF → UTF-8 with the mark removed.
 * Anything else is UTF-8. When that decode still produces U+FFFD the text is
 * kept — the ASCII words are still worth indexing — and a warning names the
 * reason so the user can re-save the file rather than wonder why search
 * cannot find it.
 */
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

export interface DecodedNote {
  text: string;
  /** Why the text may be incomplete, or null when the decode was clean. */
  warning: string | null;
}

export function decodeNote(buf: Uint8Array): DecodedNote {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: b.subarray(2, evenLength(b.length, 2)).toString('utf16le'), warning: null };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    // Node has no UTF-16BE decoder; swap the byte pairs in a copy and read
    // it as little-endian. swap16 refuses an odd length, so a trailing
    // stray byte is dropped rather than fatal.
    const le = Buffer.from(b.subarray(2, evenLength(b.length, 2)));
    return { text: le.swap16().toString('utf16le'), warning: null };
  }
  const body = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
  const text = body.toString('utf8');
  let valid = true;
  try {
    UTF8_FATAL.decode(body);
  } catch {
    valid = false;
  }
  if (!valid) {
    return {
      text,
      warning:
        'not valid UTF-8 — undecodable bytes were replaced with U+FFFD, so those words are not searchable; save the file as UTF-8',
    };
  }
  if (text.includes('\u0000')) {
    // Valid UTF-8 that is riddled with NUL bytes is almost always UTF-16
    // that lost its byte-order mark: the letters are there, interleaved
    // with NULs, and the tokenizer will not find one word of it.
    return {
      text,
      warning:
        'contains NUL bytes (UTF-16 without a byte-order mark?) — its words are not searchable; save the file as UTF-8',
    };
  }
  return { text, warning: null };
}

function evenLength(total: number, offset: number): number {
  return offset + ((total - offset) & ~1);
}
