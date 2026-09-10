import { describe, expect, it } from 'vitest';
import { display } from '../src/cli/display.js';

/**
 * The one helper that stands between note text and the terminal. It must
 * remove every control character a terminal would act on, and nothing else:
 * a vault in Japanese, a note full of emoji, or a word with combining marks
 * must read exactly as written.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const R = '�';

describe('display', () => {
  it('replaces every C0 control except tab and newline, DEL, and every C1 control', () => {
    const c0 = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('');
    const c1 = Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x80 + i)).join('');
    const out = display(`${c0}\x7f${c1}`);
    expect(out).not.toMatch(CONTROL);
    // 0x00–0x08 → 9, then \t\n kept, then 0x0b–0x1f → 21, DEL → 1, C1 → 32.
    expect(out).toBe(`${R.repeat(9)}\t\n${R.repeat(21 + 1 + 32)}`);
  });

  it('neutralises the measured sequences and keeps the attempt visible', () => {
    expect(display('\x1b[31mRED ALERT\x1b[0m')).toBe(`${R}[31mRED ALERT${R}[0m`);
    expect(display('Sec\x1b[2Ktion')).toBe(`Sec${R}[2Ktion`);
    expect(display('\x1b]0;HACKED TITLE\x07')).toBe(`${R}]0;HACKED TITLE${R}`);
    expect(display('real result\rFAKE RESULT')).toBe(`real result${R}FAKE RESULT`);
    // C1 CSI (U+009B) is a one-byte CSI on terminals that honour 8-bit controls.
    expect(display('\x9b31mred')).toBe(`${R}31mred`);
  });

  it('does not touch CJK, emoji, combining marks or typographic text', () => {
    const samples = [
      '日本語のノート — 検索',
      '한국어 메모',
      'Ελληνικά · кириллица · العربية',
      '🎉 👩‍💻 🇮🇳 ✓',
      'é ñ ö (combining marks)',
      'café naïve — “quoted” §1 −0.3 … ›',
      'col1\tcol2\nrow2',
    ];
    for (const s of samples) expect(display(s)).toBe(s);
  });

  it('is idempotent and leaves plain ASCII alone', () => {
    const s = 'plain text, with punctuation: 100% [ok] {x} <y> ~ `code`';
    expect(display(s)).toBe(s);
    const once = display('a\x1bb\x85c\x7fd');
    expect(display(once)).toBe(once);
  });
});
