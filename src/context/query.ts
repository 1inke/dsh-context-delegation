import type { ContextQuery, DelegationInput } from '../types.ts'

const MAX_RAW_TEXT = 16_000
const MAX_TERMS = 128

const ENGLISH_STOPWORDS = new Set(
  [
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
    'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'was',
    'with', 'only', 'not', 'do', 'does', 'can', 'will', 'must', 'should',
  ],
)
const CHINESE_STOPWORDS = new Set(['的', '了', '和', '与', '及', '在', '是', '为', '将', '或', '并', '这', '那', '要', '对', '中'])

function addToken(tokens: string[], seen: Set<string>, token: string): void {
  const value = token.toLocaleLowerCase('en-US')
  if (!value || ENGLISH_STOPWORDS.has(value) || CHINESE_STOPWORDS.has(value) || seen.has(value)) return
  seen.add(value)
  tokens.push(value)
}

/** Tokenize prose while retaining identifiers and their useful components. */
export function tokenizeContext(text: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  // Keep runs containing identifier/path punctuation together, then derive components.
  const runs = text.match(/[\p{L}\p{N}_./\\:-]+/gu) ?? []
  for (const run of runs) {
    const lower = run.toLocaleLowerCase('en-US')
    addToken(tokens, seen, lower)
    const pieces = run.split(/[._/\\:-]+|(?<=[a-z\d])(?=[A-Z])|(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/u)
    for (const piece of pieces) {
      if (!piece) continue
      addToken(tokens, seen, piece)
      // snake_case and kebab-case components are useful independently too.
      for (const subpiece of piece.split(/[_-]+/u)) addToken(tokens, seen, subpiece)
    }
    // Chinese is intentionally represented by both unigrams and adjacent bigrams.
    const chinese = lower.match(/[\p{Script=Han}]+/gu) ?? []
    for (const sequence of chinese) {
      const chars = [...sequence]
      for (const char of chars) addToken(tokens, seen, char)
      for (let i = 0; i + 1 < chars.length; i++) addToken(tokens, seen, chars[i]! + chars[i + 1]!)
    }
  }
  return tokens
}

export function buildContextQuery(
  input: DelegationInput,
  relevantFiles: readonly string[] = input.relevant_files ?? [],
): ContextQuery {
  const files = [...relevantFiles]
  let rawText = [
    input.task,
    files.join('\n'),
    ...(input.acceptance_criteria ?? []),
    input.notes ?? '',
  ].filter(Boolean).join('\n').slice(0, MAX_RAW_TEXT)
  const last = rawText.charCodeAt(rawText.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) rawText = rawText.slice(0, -1)
  return { rawText, terms: tokenizeContext(rawText).slice(0, MAX_TERMS), relevantFiles: files }
}
