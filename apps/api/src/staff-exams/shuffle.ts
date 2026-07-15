/**
 * Deterministic shuffling for §11.1 step 5's "Shuffle questions? Shuffle
 * options?".
 *
 * Deterministic is the whole point. A random shuffle per request means a staff
 * member who reloads mid-exam — on restaurant WiFi, on a phone, which is the
 * expected case — gets a different question order. Their answers are keyed by
 * question id so they would survive, but the experience is incoherent: question
 * 3 is suddenly a different question, and anyone who noted "I'll come back to
 * number 7" has lost it.
 *
 * Seeding on the assignment id gives every candidate their own stable order:
 * the same person always sees the same sequence, two people see different ones.
 */

/** FNV-1a: tiny, fast, and good enough to spread ids across seeds. */
function hashSeed(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Mulberry32 — a small, well-distributed seeded PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Fisher-Yates with a seeded PRNG. Returns a new array; the input is untouched.
 *
 * The same (items, seed) always produces the same order — that is what makes a
 * reload safe.
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const result = [...items]
  const random = mulberry32(hashSeed(seed))

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }

  return result
}

/**
 * Option order is seeded on the assignment AND the question, so two questions
 * in one attempt do not shuffle identically — which would put the correct
 * answer in the same position every time and make the paper guessable.
 */
export function optionSeed(assignmentId: string, questionId: string): string {
  return `${assignmentId}:${questionId}`
}
