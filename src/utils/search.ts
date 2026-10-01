// Sidebar search: every whitespace-separated term must appear (AND), matched as
// a plain substring rather than fzf-style subsequence — file names here are
// long runs of CJK plus [tags], where a subsequence matches nearly anything.

// NFKC folds full-width to half-width (ＤＬ → DL, （） → ()), so the query and
// the file name agree however either was typed.
export const normalize = (s: string) => s.normalize("NFKC").toLowerCase();

export const parseQuery = (q: string) => normalize(q).split(/\s+/).filter(Boolean);

// Characters that start a "word" in a file name (post-NFKC, so full-width
// brackets and ｜ have already become their ASCII forms)
const BOUNDARY = /[\s[\](){}【】「」『』|_\-.~・]/;

// Lower is better; -1 when some term is missing. Per term: 0 = start of text,
// 1 = start of a word, 2 = mid-word.
export function matchScore(text: string, terms: string[]): number {
  let score = 0;
  for (const t of terms) {
    const i = text.indexOf(t);
    if (i < 0) return -1;
    score += i === 0 ? 0 : BOUNDARY.test(text[i - 1]) ? 1 : 2;
  }
  return score;
}
