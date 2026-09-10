/**
 * Make note-derived text safe to print on a terminal.
 *
 * Note text reached stdout verbatim. Measured on the built product: a note
 * holding `\x1b[31m…\x1b[0m` and an OSC title-set `\x1b]0;HACKED\x07` came
 * through `lore search`, `ask`, `facts` and `timeline` intact, and the
 * terminal did what the note said — spoofed colours, a rewritten window
 * title. The same channel carries cursor moves that overwrite earlier lines
 * to fake a result, and OSC 52 clipboard writes on terminals that allow
 * them. Vault notes are untrusted (shared vaults, synced folders, notes
 * written by other agents), so what came out of one is sanitised on its way
 * to a human.
 *
 * Every C0 control except tab and newline, DEL, and every C1 control becomes
 * U+FFFD. The printable tail of an escape sequence is left as it is, so
 * `\x1b[2K` shows as `�[2K`: the attempt stays visible rather than vanishing.
 * Nothing above U+009F is touched — CJK, emoji, combining marks and
 * typographic punctuation pass through unchanged.
 *
 * Display only. The index, the journal and `--json` carry the text exactly as
 * written; a sanitised string must never be written back.
 */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function display(text: string): string {
  return text.replace(CONTROL, '�');
}
