import { PLACE_RULES_VERSION, type PlacePhrase } from './place-contracts.js';

// These are clause boundaries, not date interpretation or place-name knowledge.
const REQUIREMENT_OR_TIME = /\s+\b(?:with|during|between|from|using|requiring|before|after|by|window|on\s+(?:\d+|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|at\s+(?:a\s+)?(?:resolution|\d+)|at\s+(?:most|least)|no\s+more|maximum|minimum|(?:next|last|this|coming|previous)\s+(?:day|week|month|year|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|today|tomorrow|yesterday|tonight)\b/i;
const MEASUREMENT_CLAUSE = /(?:,\s*|\s+)(?=(?:(?:max(?:imum)?|min(?:imum)?|under|up\s+to|no\s+more\s+than)\s+)?[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:mm|cm|m|km|metres?|meters?|kilometres?|kilometers?)\s+(?:(?:ground|spatial)\s+)?(?:resolution|radius|altitude|height|swath)\b|(?:resolution|cloud\s+(?:cover|limit)|revisit|deadline|timezone)\b)/i;
const negatedLocationBefore = (text: string, start: number) => /\b(?:do\s+not|not|no|except|exclude|excluding|without)\b[^.!?;\n]{0,80}$/i.test(text.slice(Math.max(0, start - 100), start));

/** Keep bounded geographic abbreviations; unfamiliar punctuation asks for review. */
function locationBoundary(tail: string): { end: number; ambiguous: boolean } {
  const clause = [tail.search(REQUIREMENT_OR_TIME), tail.search(MEASUREMENT_CLAUSE)].filter(index => index >= 0);
  let end = clause.length ? Math.min(...clause) : tail.length;
  const protectedDots = new Set<number>();
  for (const match of tail.matchAll(/\b(?:St|Ste|Mt|Ft)\.(?=\s+\p{L})/giu)) protectedDots.add(match.index! + match[0].length - 1);
  for (const match of tail.matchAll(/(?<!\p{L})(?:\p{L}\.){2,}/gu)) {
    for (let offset = 0; offset < match[0].length; offset++) if (match[0][offset] === '.') protectedDots.add(match.index! + offset);
    // A final dotted region abbreviation followed by unexplained prose is not
    // permission to append that prose to the upstream place phrase.
    const after = match.index! + match[0].length;
    if (after < end && /^\s+\p{L}/u.test(tail.slice(after))) return { end, ambiguous: true };
  }
  for (let index = 0; index < end; index++) {
    const char = tail[index];
    if (char === '.' && protectedDots.has(index)) continue;
    if (char === '.') {
      const token = tail.slice(0, index).match(/\p{L}+$/u)?.[0] ?? '';
      if (/^(?:St|Ste|Mt|Ft)$/i.test(token) || (token.length <= 3 && /^\s+\p{L}/u.test(tail.slice(index + 1)))) return { end: index, ambiguous: true };
      end = index; break;
    }
    if (char && /[!?;\n]/.test(char)) { end = index; break; }
  }
  const fragment = tail.slice(0, end);
  return { end, ambiguous: /[/:|()[\]{}<>@&]/.test(fragment) || /\s[–—-]\s/.test(fragment) };
}

/** Bounded local grammar, deliberately separate from any network lookup. */
export function extractPlacePhrase(text: string): PlacePhrase {
  const result = (state: PlacePhrase['state'], phrase = '', start: number | null = null, reason = ''): PlacePhrase => ({ state, phrase, span: start === null ? null : { start, end: start + phrase.length }, origin: 'stated', reason, rulesVersion: PLACE_RULES_VERSION });
  if (!text.trim()) return result('none', '', null, 'Describe a location or use Find place, Select area or coordinates.');
  const quoted = [...text.matchAll(/[“"]([^”"\n]{2,200})[”"]/g)];
  if (quoted.length > 1) return result('review', '', null, 'More than one quoted location is present. Choose the place phrase before looking it up.');
  if (quoted.length === 1) {
    const match = quoted[0]!, phrase = match[1]!.trim(), start = match.index! + 1 + match[1]!.indexOf(phrase);
    if (negatedLocationBefore(text, match.index!)) return result('review', '', null, 'A negated location needs a deliberate phrase correction.');
    if (phrase) return result('ready', phrase, start, 'Quoted phrase read locally; inspect it before the disclosed search.');
  }
  const clauses: { phrase: string; start: number }[] = [];
  const starters = /\b(?:of|over|near|around|at|in)\s+/gi;
  for (const match of text.matchAll(starters)) {
    const start = match.index! + match[0].length, tail = text.slice(start);
    // A resolution, date, altitude, capacity or measurement is not a named place.
    if (/^(?:a\s+)?(?:resolution|radius|altitude|height|swath|\d|noon\b|night\b|day\b|the\s+(?:morning|afternoon|evening)\b)/i.test(tail)) continue;
    const boundary = locationBoundary(tail);
    if (boundary.ambiguous) return result('review', '', null, 'Unsupported or ambiguous location punctuation needs a deliberate phrase correction.');
    const raw = tail.slice(0, boundary.end);
    const phrase = raw.trim().replace(/[,\s]+$/g, '');
    if (phrase.length < 2 || phrase.length > 200 || !/[\p{L}]/u.test(phrase)) continue;
    if (/\b(?:imagery|images?|observations?|resolution|meters?|metres?|kilometres?|satellites?|SAR|visible|thermal|SWIR|broadband|clouds?|capacity|days?|hours?)\b/i.test(phrase)) continue;
    if (negatedLocationBefore(text, match.index!)) return result('review', '', null, 'A negated location needs a deliberate phrase correction.');
    clauses.push({ phrase, start: start + raw.indexOf(phrase) });
  }
  // Nested prepositions are part of one named phrase only when they identify the same span.
  const distinct = clauses.filter((item, index) => !clauses.some((other, n) => n !== index && other.start < item.start && other.start + other.phrase.length >= item.start + item.phrase.length));
  if (distinct.length !== 1) return result(distinct.length ? 'review' : 'none', '', null, distinct.length ? 'Several location clauses were found. Choose one phrase before looking it up.' : 'No supported place clause was found. Enter a phrase in Find place or use drawing/coordinates.');
  const chosen = distinct[0]!;
  if (/\s+(?:and|or)\s+/i.test(chosen.phrase)) return result('review', '', null, 'This phrase may name several locations. Confirm one place phrase before looking it up.');
  return result('ready', chosen.phrase, chosen.start, 'Read locally from the location clause; source results still need inspection and area confirmation.');
}
