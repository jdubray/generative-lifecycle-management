/**
 * Constraint expression evaluator.
 *
 * GLM constraints are CEL-style predicates in `node_constraints.expression`.
 * v1 ships a minimal subset of CEL — just the operators the mockup uses:
 *
 *   - comparisons:  ==  !=  <  <=  >  >=
 *   - logical:      &&  ||  !
 *   - membership:   <value> in <list>
 *   - identifiers + dot access:   pragma.foreign_keys, todo.title
 *   - literals:     numbers, strings ('x' or "x"), true, false, null
 *   - list literals:  ['a','b','c']
 *   - parentheses
 *
 * Anything else (e.g. `AFTER trim`, implication arrows from the mockup)
 * raises `CelUnsupportedError` — the caller decides whether to treat that
 * as a warning or as a constraint failure. The Phase 2 done-when only
 * requires the operators above, which match every spec.acceptance.verifier
 * predicate in the example sekkei.
 */

export class CelParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CelParseError';
  }
}

export class CelUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CelUnsupportedError';
  }
}

export type CelValue = string | number | boolean | null | CelValue[];

export type CelBindings = Record<string, unknown>;

/** Parse + evaluate `expr` against `bindings`. Throws on parse error. */
export function evaluate(expr: string, bindings: CelBindings): CelValue {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  const ast = parser.parseExpression();
  parser.expectEof();
  return evalNode(ast, bindings);
}

/**
 * Evaluate a constraint expression and return a typed pass/fail. The
 * expression must evaluate to a boolean; non-boolean results are treated
 * as failures with an explanatory reason.
 */
export function evaluateConstraint(expr: string, bindings: CelBindings): {
  passed: boolean;
  reason: string | null;
} {
  try {
    const v = evaluate(expr, bindings);
    if (typeof v !== 'boolean') {
      return { passed: false, reason: `expression did not produce a boolean (got ${typeof v})` };
    }
    return { passed: v, reason: v ? null : 'predicate evaluated to false' };
  } catch (e) {
    if (e instanceof CelParseError || e instanceof CelUnsupportedError) {
      return { passed: false, reason: e.message };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type TokenKind =
  | 'number'
  | 'string'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'dot'
  | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  /** zero-based column index (for error messages) */
  pos: number;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === undefined) break;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // strings: ' or "
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      let s = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const next = src[i + 1] ?? '';
          s += next;
          i += 2;
        } else {
          s += src[i] ?? '';
          i++;
        }
      }
      if (src[i] !== quote) throw new CelParseError(`unterminated string starting at ${start}`);
      i++;
      tokens.push({ kind: 'string', value: s, pos: start });
      continue;
    }

    // numbers
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < src.length && /[0-9.]/.test(src[i] ?? '')) i++;
      tokens.push({ kind: 'number', value: src.slice(start, i), pos: start });
      continue;
    }

    // identifiers + keywords
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i] ?? '')) i++;
      tokens.push({ kind: 'ident', value: src.slice(start, i), pos: start });
      continue;
    }

    // multi-char operators
    if (ch === '=' && src[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '==', pos: i });
      i += 2;
      continue;
    }
    if (ch === '!' && src[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '!=', pos: i });
      i += 2;
      continue;
    }
    if (ch === '<' && src[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '<=', pos: i });
      i += 2;
      continue;
    }
    if (ch === '>' && src[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '>=', pos: i });
      i += 2;
      continue;
    }
    if (ch === '&' && src[i + 1] === '&') {
      tokens.push({ kind: 'op', value: '&&', pos: i });
      i += 2;
      continue;
    }
    if (ch === '|' && src[i + 1] === '|') {
      tokens.push({ kind: 'op', value: '||', pos: i });
      i += 2;
      continue;
    }

    // single-char tokens
    switch (ch) {
      case '<':
      case '>':
      case '!':
        tokens.push({ kind: 'op', value: ch, pos: i });
        i++;
        continue;
      case '(':
        tokens.push({ kind: 'lparen', value: ch, pos: i });
        i++;
        continue;
      case ')':
        tokens.push({ kind: 'rparen', value: ch, pos: i });
        i++;
        continue;
      case '[':
        tokens.push({ kind: 'lbracket', value: ch, pos: i });
        i++;
        continue;
      case ']':
        tokens.push({ kind: 'rbracket', value: ch, pos: i });
        i++;
        continue;
      case ',':
        tokens.push({ kind: 'comma', value: ch, pos: i });
        i++;
        continue;
      case '.':
        tokens.push({ kind: 'dot', value: ch, pos: i });
        i++;
        continue;
      default:
        throw new CelUnsupportedError(`unexpected character '${ch}' at ${i}`);
    }
  }
  tokens.push({ kind: 'eof', value: '', pos: src.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser → AST
// ---------------------------------------------------------------------------

type AstNode =
  | { type: 'lit'; value: CelValue }
  | { type: 'list'; items: AstNode[] }
  | { type: 'ident'; path: string[] }
  | { type: 'unary'; op: '!'; arg: AstNode }
  | { type: 'binary'; op: BinaryOp; left: AstNode; right: AstNode };

type BinaryOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||' | 'in';

class Parser {
  private readonly tokens: Token[];
  private i = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  expectEof(): void {
    if (this.peek().kind !== 'eof') {
      throw new CelParseError(`unexpected token '${this.peek().value}' at ${this.peek().pos}`);
    }
  }

  parseExpression(): AstNode {
    return this.parseOr();
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.matchOp('||')) left = { type: 'binary', op: '||', left, right: this.parseAnd() };
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseNot();
    while (this.matchOp('&&')) left = { type: 'binary', op: '&&', left, right: this.parseNot() };
    return left;
  }

  private parseNot(): AstNode {
    if (this.matchOp('!')) return { type: 'unary', op: '!', arg: this.parseNot() };
    return this.parseComparison();
  }

  private parseComparison(): AstNode {
    const left = this.parsePrimary();
    const t = this.peek();
    if (t.kind === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.value)) {
      this.i++;
      const right = this.parsePrimary();
      return { type: 'binary', op: t.value as BinaryOp, left, right };
    }
    if (t.kind === 'ident' && t.value === 'in') {
      this.i++;
      const right = this.parsePrimary();
      return { type: 'binary', op: 'in', left, right };
    }
    return left;
  }

  private parsePrimary(): AstNode {
    const t = this.peek();
    switch (t.kind) {
      case 'number':
        this.i++;
        return { type: 'lit', value: Number.parseFloat(t.value) };
      case 'string':
        this.i++;
        return { type: 'lit', value: t.value };
      case 'ident': {
        this.i++;
        if (t.value === 'true') return { type: 'lit', value: true };
        if (t.value === 'false') return { type: 'lit', value: false };
        if (t.value === 'null') return { type: 'lit', value: null };
        const path = [t.value];
        while (this.peek().kind === 'dot') {
          this.i++;
          const next = this.peek();
          if (next.kind !== 'ident') throw new CelParseError(`expected identifier after '.' at ${next.pos}`);
          path.push(next.value);
          this.i++;
        }
        return { type: 'ident', path };
      }
      case 'lparen': {
        this.i++;
        const e = this.parseExpression();
        if (this.peek().kind !== 'rparen') throw new CelParseError(`expected ')' at ${this.peek().pos}`);
        this.i++;
        return e;
      }
      case 'lbracket': {
        this.i++;
        const items: AstNode[] = [];
        if (this.peek().kind !== 'rbracket') {
          items.push(this.parsePrimary());
          while (this.peek().kind === 'comma') {
            this.i++;
            items.push(this.parsePrimary());
          }
        }
        if (this.peek().kind !== 'rbracket') throw new CelParseError(`expected ']' at ${this.peek().pos}`);
        this.i++;
        return { type: 'list', items };
      }
      default:
        throw new CelParseError(`unexpected token '${t.value}' at ${t.pos}`);
    }
  }

  private peek(): Token {
    const t = this.tokens[this.i];
    if (!t) throw new CelParseError('unexpected end of input');
    return t;
  }

  private matchOp(op: string): boolean {
    const t = this.peek();
    if (t.kind === 'op' && t.value === op) {
      this.i++;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// AST evaluator
// ---------------------------------------------------------------------------

function evalNode(node: AstNode, bindings: CelBindings): CelValue {
  switch (node.type) {
    case 'lit':
      return node.value;
    case 'list':
      return node.items.map((it) => evalNode(it, bindings));
    case 'ident':
      return resolveIdent(node.path, bindings);
    case 'unary': {
      const v = evalNode(node.arg, bindings);
      if (typeof v !== 'boolean') {
        throw new CelUnsupportedError('! requires a boolean operand');
      }
      return !v;
    }
    case 'binary':
      return evalBinary(node.op, evalNode(node.left, bindings), evalNode(node.right, bindings));
  }
}

function evalBinary(op: BinaryOp, left: CelValue, right: CelValue): CelValue {
  switch (op) {
    case '==':
      return equals(left, right);
    case '!=':
      return !equals(left, right);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compare(op, left, right);
    case '&&':
      requireBool('&&', left, right);
      return (left as boolean) && (right as boolean);
    case '||':
      requireBool('||', left, right);
      return (left as boolean) || (right as boolean);
    case 'in':
      if (!Array.isArray(right)) {
        throw new CelUnsupportedError('in requires a list on the right-hand side');
      }
      return right.some((it) => equals(it, left));
  }
}

function compare(op: '<' | '<=' | '>' | '>=', l: CelValue, r: CelValue): boolean {
  if (typeof l !== typeof r) {
    throw new CelUnsupportedError(`cannot compare ${typeof l} and ${typeof r}`);
  }
  if (typeof l === 'number' && typeof r === 'number') {
    return cmp(op, l, r);
  }
  if (typeof l === 'string' && typeof r === 'string') {
    return cmp(op, l, r);
  }
  throw new CelUnsupportedError(`comparison only supports numbers and strings`);
}

function cmp(op: '<' | '<=' | '>' | '>=', a: number | string, b: number | string): boolean {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
  }
}

function equals(a: CelValue, b: CelValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equals(a[i] as CelValue, b[i] as CelValue)) return false;
    }
    return true;
  }
  return a === b;
}

function requireBool(op: string, l: CelValue, r: CelValue): void {
  if (typeof l !== 'boolean' || typeof r !== 'boolean') {
    throw new CelUnsupportedError(`${op} requires boolean operands`);
  }
}

function resolveIdent(path: string[], bindings: CelBindings): CelValue {
  let cur: unknown = bindings;
  for (const segment of path) {
    if (cur === null || cur === undefined) {
      throw new CelUnsupportedError(`identifier '${path.join('.')}' is undefined`);
    }
    if (typeof cur === 'string' && segment === 'length') {
      cur = cur.length;
      continue;
    }
    if (Array.isArray(cur) && segment === 'length') {
      cur = cur.length;
      continue;
    }
    if (typeof cur !== 'object' || cur === null) {
      throw new CelUnsupportedError(`cannot access '.${segment}' on non-object`);
    }
    cur = (cur as Record<string, unknown>)[segment];
  }
  if (cur === undefined) {
    throw new CelUnsupportedError(`identifier '${path.join('.')}' is undefined`);
  }
  return cur as CelValue;
}
