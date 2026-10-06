/**
 * Phoneme fix: force Vietnamese reading for words that espeak-vi
 * misclassifies as English.
 *
 * Root cause example: espeak voice "vi" tags toneless "veo" as English:
 *   phonemize('veo','vi') -> ["(en)v'iː7əʊəʊ(vi)"]  (reads like "Vi-o")
 * while true Vietnamese siblings read natively:
 *   keo->k'E7w, leo->l'E7w, beo->b'E7w, xeo->s'E7w
 * Our text pipeline already keeps "veo" (detector=true, CSV veo->veo),
 * so the only place to fix is right after phonemize, before the
 * (en)/(vi) markers are stripped and IDs are mapped.
 *
 * HOW TO ADD A NEW WORD (e.g. "hi"):
 *   1. Verify the bug is real - both must hold:
 *        isVietnameseWord('hi') === true
 *        await phonemize('hi', 'vi') contains "(en)...(vi)"
 *      (If the detector says false, the word already goes through
 *      transliteration - different pipeline, not this fix.)
 *   2. Dump the exact codepoints of the English phonemes, e.g.:
 *        [...s].map(c => c.codePointAt(0).toString(16))
 *      (Looks can deceive: əʊəʊ vs əʊʊ bit us once.)
 *   3. Find the Vietnamese target by mirroring a same-rhyme sibling
 *      that already reads correctly, then confirm by listening to
 *      one generated wav.
 *   4. Add one entry below - that is all. The three textToPhonemes
 *      call sites (piper-tts.js, piper-tts-i18n.js, tts-cli.mjs) share
 *      this helper, so they all pick it up with no further changes.
 *   5. Add tests mirroring the "veo" cases (standalone detect incl.
 *      hyphenated negatives, tagged + stripped replace, en-voice
 *      guard, other words untouched).
 */

/**
 * Per-word overrides. Each entry:
 * - replacement: Vietnamese phoneme string to substitute in.
 * - tagged:   regex matching the raw phonemizer output, including
 *             the "(en)...(vi)" wrapper. Must have the /g flag.
 * - stripped: regex matching the same phonemes after (en)/(vi)
 *             markers were removed upstream. Must have the /g flag.
 */
export const VIETNAMESE_PHONEME_OVERRIDES = {
  // v + eo, ngang tone (7), mirroring keo -> k'E7w
  veo: {
    replacement: 'v\u02c8\u025b7w',
    // "(en)vˈiː7əʊəʊ(vi)" (standalone) or "(en)vˈiː1əʊəʊ(vi)" (in sentence).
    // Note: the tail is əʊəʊ (U+0259 U+028A twice), not əʊʊ.
    tagged: /\(en\)v\u02c8i\u02d0\d(?:\u0259\u028a){2}\(vi\)/g,
    stripped: /v\u02c8i\u02d0\d(?:\u0259\u028a){2}/g,
  },
};

/**
 * Check if text contains `word` as a standalone word (case-insensitive).
 * Excludes hyphen-adjacent matches so "veo-ca-ri-an"
 * (from Velcarian -> veo-ca-ri-an) does NOT match "veo",
 * and "video" does not match "veo" either.
 */
export function hasStandaloneWord(text, word) {
  if (!text || typeof text !== 'string') return false;
  if (!word || typeof word !== 'string') return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Standalone = not adjacent to word chars or hyphens.
  // \w misses Vietnamese diacritics, so include A-y ranges explicitly.
  return new RegExp(`(?<![A-Za-zÀ-ỹà-ỹ0-9_-])${escaped}(?![A-Za-zÀ-ỹà-ỹ0-9_-])`, 'i').test(text);
}

/**
 * Replace espeak's English fallback phonemes with the Vietnamese
 * reading for every word in VIETNAMESE_PHONEME_OVERRIDES found
 * standalone in the original text. Handles both tagged "(en)...(vi)"
 * form (raw phonemizer output) and stripped form (markers removed).
 *
 * @param {string} originalText - chunk text fed to phonemize
 * @param {string} phonemeText - phonemizer output (merged string)
 * @param {string} voice - espeak voice (only applies when voice is "vi")
 * @returns {string} fixed phoneme text (or input unchanged)
 */
export function forceVietnamesePhonemes(originalText, phonemeText, voice) {
  if (!originalText || typeof originalText !== 'string') return phonemeText;
  if (!phonemeText || typeof phonemeText !== 'string') return phonemeText;

  // Only the Vietnamese model is affected (espeak voice "vi").
  if (voice && typeof voice === 'string' && !voice.toLowerCase().startsWith('vi')) {
    return phonemeText;
  }

  let result = phonemeText;
  for (const word of Object.keys(VIETNAMESE_PHONEME_OVERRIDES)) {
    if (!hasStandaloneWord(originalText, word)) {
      continue;
    }
    const { replacement, tagged, stripped } = VIETNAMESE_PHONEME_OVERRIDES[word];
    result = result.replace(tagged, replacement).replace(stripped, replacement);
  }

  return result;
}
