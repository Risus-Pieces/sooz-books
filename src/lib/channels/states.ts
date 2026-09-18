/**
 * US state codes, for reading a jurisdiction out of a tax line's name
 * (`NY State Tax`, `Texas State Tax`, `CA County Tax`).
 */

const STATES: Readonly<Record<string, string>> = Object.freeze({
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
});

const BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]),
);

export function isStateCode(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(STATES, value);
}

/** The state a tax line names, by leading code or full state name; `null` for anything else. */
export function stateFromTaxName(name: string): string | null {
  const text = name.trim();
  const code = /^([A-Z]{2})\b/.exec(text);
  if (code !== null && isStateCode(code[1])) return code[1];
  const lower = text.toLowerCase();
  let best: string | null = null;
  let bestLength = 0;
  for (const [stateLower, stateCode] of BY_NAME) {
    if (lower.startsWith(stateLower) && stateLower.length > bestLength) {
      best = stateCode;
      bestLength = stateLower.length;
    }
  }
  return best;
}
