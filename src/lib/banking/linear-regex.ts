/**
 * A regular-expression matcher that runs in time linear in its input.
 *
 * Categorization rules are owner-authored and live in a jsonb column, and a regex
 * condition used to be handed straight to `RegExp`. V8's engine backtracks, so a
 * pattern as innocent-looking as `\d*\d*\d*\d*\d*x` or `.*.*.*.*.*!` takes
 * O(n^k) steps on a string that almost matches — seconds at 80 characters, hours at
 * 200 — and `RegExp.prototype.test` is synchronous, so no time budget measured
 * around it can stop a match that is already running. Refusing "dangerous shapes"
 * up front is a heuristic that one more shape defeats.
 *
 * This module removes the class of problem instead of chasing its members. A
 * pattern is parsed into a small syntax tree, compiled to a Thompson NFA, and run
 * as a Pike VM: every input position is visited once, and at each position every
 * NFA state is visited at most once. Matching costs O(input × pattern) whatever
 * the pattern is. There is nothing to time out.
 *
 * The supported syntax is the part of JavaScript's regex syntax that has
 * linear-time semantics, with JavaScript's meaning (no flags; case-sensitive):
 * literals and escapes, `.`, character classes with ranges and negation,
 * `\d \D \w \W \s \S`, `^ $ \b \B`, groups (capturing, non-capturing and named —
 * all of them only group here), alternation, and the quantifiers `* + ? {n}
 * {n,} {n,m}` and their lazy forms. Back-references and lookaround need
 * backtracking by definition and are refused with a reason, never approximated.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** A repetition count above this is a typo or an attack, not a bank rule. */
const MAX_REPEAT = 1000;

/**
 * The compiled program's size cap. `(a{100}){100}` is 10,000 states: each input
 * character would then cost 10,000 steps, which is linear but not cheap. The cap
 * keeps the per-character constant small and the refusal explicit.
 */
const MAX_PROGRAM_SIZE = 5000;

export class LinearRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearRegexError';
  }
}

// ---------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------

type CharTest = (code: number) => boolean;
type Assertion = 'start' | 'end' | 'word_boundary' | 'not_word_boundary';

type Node =
  | { readonly kind: 'empty' }
  | { readonly kind: 'char'; readonly test: CharTest }
  | { readonly kind: 'assert'; readonly assertion: Assertion }
  | { readonly kind: 'concat'; readonly items: readonly Node[] }
  | { readonly kind: 'alt'; readonly options: readonly Node[] }
  | { readonly kind: 'repeat'; readonly node: Node; readonly min: number; readonly max: number };

const isDigit: CharTest = (c) => c >= 48 && c <= 57;
const isWordChar: CharTest = (c) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

/** JavaScript's `\s`: WhiteSpace plus LineTerminator. */
const isSpace: CharTest = (c) =>
  c === 0x09 ||
  c === 0x0a ||
  c === 0x0b ||
  c === 0x0c ||
  c === 0x0d ||
  c === 0x20 ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;

const isLineTerminator: CharTest = (c) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;

const not =
  (test: CharTest): CharTest =>
  (c) =>
    !test(c);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface Quantifier {
  readonly min: number;
  readonly max: number;
  readonly length: number;
}

class Parser {
  private pos = 0;

  constructor(private readonly source: string) {}

  parse(): Node {
    const node = this.parseAlternation();
    if (this.pos < this.source.length) {
      // The only way to stop early is an unmatched `)`.
      throw new LinearRegexError(`unbalanced ")" at position ${this.pos}`);
    }
    return node;
  }

  private peek(offset = 0): string | undefined {
    return this.source[this.pos + offset];
  }

  private parseAlternation(): Node {
    const options: Node[] = [this.parseSequence()];
    while (this.peek() === '|') {
      this.pos += 1;
      options.push(this.parseSequence());
    }
    return options.length === 1 ? options[0] : { kind: 'alt', options };
  }

  private parseSequence(): Node {
    const items: Node[] = [];
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === '|' || ch === ')') break;
      items.push(this.parseQuantified());
    }
    if (items.length === 0) return { kind: 'empty' };
    return items.length === 1 ? items[0] : { kind: 'concat', items };
  }

  private parseQuantified(): Node {
    const atom = this.parseAtom();
    const quantifier = this.readQuantifier();
    if (quantifier === null) return atom;
    if (atom.kind === 'assert') {
      throw new LinearRegexError('an anchor or word boundary cannot be repeated');
    }
    this.pos += quantifier.length;
    // A lazy quantifier matches the same set of strings; `test()` only asks whether one exists.
    if (this.peek() === '?') this.pos += 1;
    if (this.readQuantifier() !== null) {
      throw new LinearRegexError(`nothing to repeat at position ${this.pos}`);
    }
    return { kind: 'repeat', node: atom, min: quantifier.min, max: quantifier.max };
  }

  /** The quantifier at the cursor, without consuming it; `null` when there is none. */
  private readQuantifier(): Quantifier | null {
    const ch = this.peek();
    if (ch === '*') return { min: 0, max: Number.POSITIVE_INFINITY, length: 1 };
    if (ch === '+') return { min: 1, max: Number.POSITIVE_INFINITY, length: 1 };
    if (ch === '?') return { min: 0, max: 1, length: 1 };
    if (ch !== '{') return null;

    const close = this.source.indexOf('}', this.pos);
    if (close === -1) return null;
    // JavaScript (Annex B) reads a brace that is not a well-formed quantifier as a literal.
    const bounded = /^(\d+)(?:(,)(\d*))?$/.exec(this.source.slice(this.pos + 1, close));
    if (bounded === null) return null;

    const min = Number(bounded[1]);
    const max =
      bounded[2] === undefined
        ? min
        : bounded[3] === ''
          ? Number.POSITIVE_INFINITY
          : Number(bounded[3]);
    if (min > max) throw new LinearRegexError(`numbers out of order in {${min},${max}}`);
    if (min > MAX_REPEAT || (Number.isFinite(max) && max > MAX_REPEAT)) {
      throw new LinearRegexError(`a repetition count above ${MAX_REPEAT} is not allowed`);
    }
    return { min, max, length: close - this.pos + 1 };
  }

  private parseAtom(): Node {
    const ch = this.peek();
    if (ch === undefined) throw new LinearRegexError('unexpected end of pattern');

    switch (ch) {
      case '(':
        return this.parseGroup();
      case '[':
        return this.parseClass();
      case '.':
        this.pos += 1;
        return { kind: 'char', test: not(isLineTerminator) };
      case '^':
        this.pos += 1;
        return { kind: 'assert', assertion: 'start' };
      case '$':
        this.pos += 1;
        return { kind: 'assert', assertion: 'end' };
      case '\\':
        return this.parseEscape();
      case '*':
      case '+':
      case '?':
        throw new LinearRegexError(`nothing to repeat at position ${this.pos}`);
      case '{':
        if (this.readQuantifier() !== null) {
          throw new LinearRegexError(`nothing to repeat at position ${this.pos}`);
        }
        this.pos += 1;
        return literal(ch.charCodeAt(0));
      default:
        this.pos += 1;
        return literal(ch.charCodeAt(0));
    }
  }

  private parseGroup(): Node {
    const start = this.pos;
    this.pos += 1; // (
    if (this.peek() === '?') {
      const next = this.peek(1);
      if (next === ':') {
        this.pos += 2;
      } else if (next === '=' || next === '!') {
        throw new LinearRegexError('lookahead is not supported: it needs a backtracking engine');
      } else if (next === '<') {
        const after = this.peek(2);
        if (after === '=' || after === '!') {
          throw new LinearRegexError('lookbehind is not supported: it needs a backtracking engine');
        }
        const close = this.source.indexOf('>', this.pos);
        const name = close === -1 ? '' : this.source.slice(this.pos + 2, close);
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
          throw new LinearRegexError(`invalid group name at position ${start}`);
        }
        this.pos = close + 1;
      } else {
        throw new LinearRegexError(`invalid group at position ${start}`);
      }
    }

    const body = this.parseAlternation();
    if (this.peek() !== ')') throw new LinearRegexError('unbalanced "("');
    this.pos += 1;
    return body;
  }

  /** `\d`, `\n`, `\x41`, `\.` … outside a class. */
  private parseEscape(): Node {
    this.pos += 1; // backslash
    const ch = this.peek();
    if (ch === undefined) throw new LinearRegexError('the pattern ends in a lone backslash');

    if (ch === 'b' || ch === 'B') {
      this.pos += 1;
      return { kind: 'assert', assertion: ch === 'b' ? 'word_boundary' : 'not_word_boundary' };
    }
    if (ch >= '1' && ch <= '9') {
      throw new LinearRegexError('back-references are not supported: they need a backtracking engine');
    }
    if (ch === 'k' && this.peek(1) === '<') {
      throw new LinearRegexError('named back-references are not supported');
    }

    const test = this.classEscape(ch);
    if (test !== null) {
      this.pos += 1;
      return { kind: 'char', test };
    }
    return literal(this.characterEscape(false));
  }

  /** `\d \D \w \W \s \S` as a predicate, or null for any other escape letter. */
  private classEscape(ch: string): CharTest | null {
    switch (ch) {
      case 'd':
        return isDigit;
      case 'D':
        return not(isDigit);
      case 'w':
        return isWordChar;
      case 'W':
        return not(isWordChar);
      case 's':
        return isSpace;
      case 'S':
        return not(isSpace);
      default:
        return null;
    }
  }

  /**
   * A single-character escape, cursor on the character after the backslash.
   * Consumes it and returns its code unit.
   */
  private characterEscape(inClass: boolean): number {
    const ch = this.peek() as string;
    this.pos += 1;
    switch (ch) {
      case 't':
        return 0x09;
      case 'n':
        return 0x0a;
      case 'v':
        return 0x0b;
      case 'f':
        return 0x0c;
      case 'r':
        return 0x0d;
      case '0':
        if (/\d/.test(this.peek() ?? '')) {
          throw new LinearRegexError('octal escapes are not supported');
        }
        return 0;
      case 'b':
        // Only reachable inside a class, where `\b` is a backspace.
        return inClass ? 0x08 : 0x62;
      case 'x': {
        const hex = this.source.slice(this.pos, this.pos + 2);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          this.pos += 2;
          return parseInt(hex, 16);
        }
        return 0x78; // a literal "x", as JavaScript reads a malformed \x
      }
      case 'u': {
        const hex = this.source.slice(this.pos, this.pos + 4);
        if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
          this.pos += 4;
          return parseInt(hex, 16);
        }
        return 0x75;
      }
      case 'c': {
        const letter = this.peek();
        if (letter !== undefined && /[A-Za-z]/.test(letter)) {
          this.pos += 1;
          return letter.charCodeAt(0) % 32;
        }
        // JavaScript reads a malformed \c as the two characters "\c".
        this.pos -= 1;
        return 0x5c;
      }
      default:
        // An identity escape: `\.`, `\/`, `\-`, and (outside unicode mode) any other letter.
        return ch.charCodeAt(0);
    }
  }

  private parseClass(): Node {
    this.pos += 1; // [
    let negated = false;
    if (this.peek() === '^') {
      negated = true;
      this.pos += 1;
    }

    const tests: CharTest[] = [];
    while (true) {
      const ch = this.peek();
      if (ch === undefined) throw new LinearRegexError('unterminated character class');
      if (ch === ']') {
        this.pos += 1;
        break;
      }

      const low = this.classAtom();
      if (this.peek() === '-' && this.peek(1) !== undefined && this.peek(1) !== ']') {
        this.pos += 1; // -
        const high = this.classAtom();
        if (typeof low === 'number' && typeof high === 'number') {
          if (low > high) throw new LinearRegexError('range out of order in character class');
          tests.push((c) => c >= low && c <= high);
        } else {
          // Annex B: a range with a class escape at either end is the three atoms, literally.
          tests.push(toTest(low), (c) => c === 0x2d, toTest(high));
        }
        continue;
      }
      tests.push(toTest(low));
    }

    const member: CharTest = (c) => tests.some((test) => test(c));
    return { kind: 'char', test: negated ? not(member) : member };
  }

  /** One class member: a code unit, or a predicate for `\d`-style escapes. */
  private classAtom(): number | CharTest {
    const ch = this.peek() as string;
    if (ch !== '\\') {
      this.pos += 1;
      return ch.charCodeAt(0);
    }
    this.pos += 1;
    const escaped = this.peek();
    if (escaped === undefined) throw new LinearRegexError('unterminated character class');
    const test = this.classEscape(escaped);
    if (test !== null) {
      this.pos += 1;
      return test;
    }
    return this.characterEscape(true);
  }
}

function literal(code: number): Node {
  return { kind: 'char', test: (c) => c === code };
}

function toTest(atom: number | CharTest): CharTest {
  return typeof atom === 'number' ? (c) => c === atom : atom;
}

// ---------------------------------------------------------------------------
// Compiler — Thompson construction into a flat program
// ---------------------------------------------------------------------------

type Instruction =
  | { op: 'char'; test: CharTest }
  | { op: 'assert'; assertion: Assertion }
  | { op: 'split'; x: number; y: number }
  | { op: 'jump'; to: number }
  | { op: 'match' };

class Compiler {
  readonly program: Instruction[] = [];

  private emit(instruction: Instruction): number {
    if (this.program.length >= MAX_PROGRAM_SIZE) {
      throw new LinearRegexError(
        `the pattern expands to more than ${MAX_PROGRAM_SIZE} states; use fewer or smaller repetitions`,
      );
    }
    this.program.push(instruction);
    return this.program.length - 1;
  }

  compile(node: Node): void {
    switch (node.kind) {
      case 'empty':
        return;
      case 'char':
        this.emit({ op: 'char', test: node.test });
        return;
      case 'assert':
        this.emit({ op: 'assert', assertion: node.assertion });
        return;
      case 'concat':
        for (const item of node.items) this.compile(item);
        return;
      case 'alt': {
        const jumps: number[] = [];
        for (let index = 0; index < node.options.length; index += 1) {
          const last = index === node.options.length - 1;
          if (last) {
            this.compile(node.options[index]);
            break;
          }
          const split = this.emit({ op: 'split', x: 0, y: 0 });
          this.patchSplit(split, this.program.length, null);
          this.compile(node.options[index]);
          jumps.push(this.emit({ op: 'jump', to: 0 }));
          this.patchSplit(split, null, this.program.length);
        }
        for (const jump of jumps) this.patchJump(jump, this.program.length);
        return;
      }
      case 'repeat': {
        for (let index = 0; index < node.min; index += 1) this.compile(node.node);
        if (node.max === Number.POSITIVE_INFINITY) {
          const loop = this.emit({ op: 'split', x: 0, y: 0 });
          this.patchSplit(loop, this.program.length, null);
          this.compile(node.node);
          this.emit({ op: 'jump', to: loop });
          this.patchSplit(loop, null, this.program.length);
          return;
        }
        const exits: number[] = [];
        for (let index = node.min; index < node.max; index += 1) {
          const split = this.emit({ op: 'split', x: 0, y: 0 });
          this.patchSplit(split, this.program.length, null);
          exits.push(split);
          this.compile(node.node);
        }
        for (const split of exits) this.patchSplit(split, null, this.program.length);
        return;
      }
    }
  }

  /** Appends the accepting state. It counts toward the size cap like any other. */
  finish(): void {
    this.emit({ op: 'match' });
  }

  private patchSplit(at: number, x: number | null, y: number | null): void {
    const instruction = this.program[at];
    if (instruction.op !== 'split') return;
    if (x !== null) instruction.x = x;
    if (y !== null) instruction.y = y;
  }

  private patchJump(at: number, to: number): void {
    const instruction = this.program[at];
    if (instruction.op === 'jump') instruction.to = to;
  }
}

// ---------------------------------------------------------------------------
// The matcher — a Pike VM over the program
// ---------------------------------------------------------------------------

export interface LinearRegex {
  /** The pattern as written. */
  readonly source: string;
  /** Number of NFA states; the per-character cost of a match. */
  readonly size: number;
  /** Same answer as `new RegExp(source).test(input)`, in O(input × size) time. */
  test(input: string): boolean;
}

function assertionHolds(assertion: Assertion, input: string, pos: number): boolean {
  switch (assertion) {
    case 'start':
      return pos === 0;
    case 'end':
      return pos === input.length;
    case 'word_boundary':
    case 'not_word_boundary': {
      const before = pos > 0 && isWordChar(input.charCodeAt(pos - 1));
      const after = pos < input.length && isWordChar(input.charCodeAt(pos));
      return assertion === 'word_boundary' ? before !== after : before === after;
    }
  }
}

function createMatcher(source: string, program: readonly Instruction[]): LinearRegex {
  const size = program.length;

  return {
    source,
    size,
    test(input: string): boolean {
      // `mark[pc] === generation` means state pc is already in the list for this
      // position. Each position gets a fresh generation, so no clearing is needed.
      const mark = new Int32Array(size).fill(-1);
      let current: number[] = [];
      let next: number[] = [];
      const stack: number[] = [];

      /** Adds `pc` and everything reachable from it without consuming input. */
      const add = (list: number[], start: number, pos: number): boolean => {
        stack.push(start);
        while (stack.length > 0) {
          const pc = stack.pop() as number;
          if (mark[pc] === pos) continue;
          mark[pc] = pos;
          const instruction = program[pc];
          switch (instruction.op) {
            case 'match':
              stack.length = 0;
              return true;
            case 'jump':
              stack.push(instruction.to);
              break;
            case 'split':
              // y first so x is explored first; order is irrelevant for a yes/no answer.
              stack.push(instruction.y, instruction.x);
              break;
            case 'assert':
              if (assertionHolds(instruction.assertion, input, pos)) stack.push(pc + 1);
              break;
            case 'char':
              list.push(pc);
              break;
          }
        }
        return false;
      };

      for (let pos = 0; ; pos += 1) {
        // Unanchored search: a match may begin at any position.
        if (add(current, 0, pos)) return true;
        if (pos === input.length) return false;

        const code = input.charCodeAt(pos);
        next.length = 0;
        for (const pc of current) {
          const instruction = program[pc];
          if (instruction.op === 'char' && instruction.test(code)) {
            if (add(next, pc + 1, pos + 1)) return true;
          }
        }
        const swap = current;
        current = next;
        next = swap;
      }
    },
  };
}

/**
 * Parses and compiles a pattern, or throws `LinearRegexError` explaining why it
 * cannot be used. The pattern must also be one JavaScript itself accepts, so a
 * rule never means one thing here and another in a regex tester.
 */
export function compileLinearRegex(source: string): LinearRegex {
  try {
    new RegExp(source);
  } catch (error) {
    throw new LinearRegexError(
      `the pattern does not compile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const tree = new Parser(source).parse();
  const compiler = new Compiler();
  compiler.compile(tree);
  compiler.finish();
  return createMatcher(source, compiler.program);
}
