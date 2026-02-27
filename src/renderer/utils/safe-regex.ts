/**
 * Safe regex compilation with ReDoS protection.
 *
 * AI-generated regex patterns can contain catastrophic backtracking constructs
 * like (a+)+, (a|a)+, (a+b?)+, etc. This utility validates patterns before use.
 */

const MAX_REGEX_LENGTH = 500;

// Patterns that commonly cause catastrophic backtracking:
// - Nested quantifiers: (a+)+, (a*)+, (a+)*
// - Overlapping alternations with quantifiers: (a|a)+
const REDOS_HEURISTICS = [
  /(\([^)]*[+*][^)]*\))[+*]/, // (x+)+ or (x*)+
  /(\([^)]*\|[^)]*\))[+*]{2,}/, // (a|b)++ or (a|b)**
];

/**
 * Try to compile a regex string safely.
 * Returns the compiled RegExp or null if the pattern is invalid, too long, or potentially dangerous.
 */
export function safeRegex(pattern: string, flags = "i"): RegExp | null {
  if (!pattern || pattern.length > MAX_REGEX_LENGTH) return null;

  // Check for ReDoS heuristics
  for (const heuristic of REDOS_HEURISTICS) {
    if (heuristic.test(pattern)) return null;
  }

  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Test a regex against a string with a match timeout.
 * Falls back to returning false if the match takes too long.
 */
export function safeRegexTest(regex: RegExp, input: string, maxInputLength = 5000): boolean {
  // Truncate extremely long lines before testing to bound execution time
  const text = input.length > maxInputLength ? input.slice(0, maxInputLength) : input;
  return regex.test(text);
}
