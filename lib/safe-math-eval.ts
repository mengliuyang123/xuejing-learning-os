/**
 * Safe, deterministic, zero-eval recursive-descent math expression evaluator.
 * Designed for Level 3 ParameterSimulatorWidget formulas (math, physics, photography,
 * algorithms, finance, ML) without ever invoking `eval` or `new Function`.
 */

const MAX_EXPR_LENGTH = 300;
const MAX_TOKENS = 180;
const MAX_DEPTH = 32;

const FORBIDDEN_IDENTIFIERS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "window",
  "globalthis",
  "global",
  "process",
  "require",
  "eval",
  "function",
  "import",
]);

const CONSTANTS: Record<string, number> = Object.assign(Object.create(null), {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
});

type MathFn = (...args: number[]) => number;

const FUNCTIONS: Record<string, MathFn> = Object.assign(Object.create(null), {
  abs: (x: number) => Math.abs(x),
  sqrt: (x: number) => (x < 0 ? NaN : Math.sqrt(x)),
  pow: (x: number, y: number) => Math.pow(x, y),
  exp: (x: number) => Math.exp(x),
  log: (x: number) => (x <= 0 ? NaN : Math.log(x)),
  ln: (x: number) => (x <= 0 ? NaN : Math.log(x)),
  log10: (x: number) => (x <= 0 ? NaN : Math.log10(x)),
  log2: (x: number) => (x <= 0 ? NaN : Math.log2(x)),
  sin: (x: number) => Math.sin(x),
  cos: (x: number) => Math.cos(x),
  tan: (x: number) => Math.tan(x),
  round: (x: number, digits?: number) => {
    if (digits === undefined) return Math.round(x);
    const f = Math.pow(10, Math.max(0, Math.min(8, Math.trunc(digits))));
    return Math.round(x * f) / f;
  },
  floor: (x: number) => Math.floor(x),
  ceil: (x: number) => Math.ceil(x),
  sign: (x: number) => Math.sign(x),
  min: (...xs: number[]) => (xs.length ? Math.min(...xs) : NaN),
  max: (...xs: number[]) => (xs.length ? Math.max(...xs) : NaN),
  clamp: (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x)),
  if: (cond: number, a: number, b: number) => (cond ? a : b),
});

type TokenType = "num" | "ident" | "op" | "paren" | "comma" | "qmark" | "colon";

interface Token {
  type: TokenType;
  value: string;
}

function tokenize(expr: string): Token[] | null {
  if (!expr || expr.length > MAX_EXPR_LENGTH) return null;
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    if (tokens.length > MAX_TOKENS) return null;
    const ch = expr[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Number literal (supports decimals & scientific notation like 1e-3)
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(expr[i + 1] || ""))) {
      let start = i;
      while (i < expr.length && /[0-9.]/.test(expr[i])) i++;
      if (i < expr.length && (expr[i] === "e" || expr[i] === "E")) {
        i++;
        if (i < expr.length && (expr[i] === "+" || expr[i] === "-")) i++;
        if (i >= expr.length || !/[0-9]/.test(expr[i])) return null;
        while (i < expr.length && /[0-9]/.test(expr[i])) i++;
      }
      const raw = expr.slice(start, i);
      if (!Number.isFinite(Number(raw))) return null;
      tokens.push({ type: "num", value: raw });
      continue;
    }

    // Identifier
    if (/[A-Za-z_]/.test(ch)) {
      let start = i;
      while (i < expr.length && /[A-Za-z0-9_]/.test(expr[i])) i++;
      const ident = expr.slice(start, i);
      if (FORBIDDEN_IDENTIFIERS.has(ident.toLowerCase())) return null;
      tokens.push({ type: "ident", value: ident });
      continue;
    }

    // Two-char operators
    const two = expr.slice(i, i + 2);
    if (
      two === "<=" ||
      two === ">=" ||
      two === "==" ||
      two === "!=" ||
      two === "**"
    ) {
      tokens.push({ type: "op", value: two === "**" ? "^" : two });
      i += 2;
      continue;
    }

    // Single-char operators
    if ("+-*/%^<>".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }

    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch });
      i++;
      continue;
    }
    if (ch === "?") {
      tokens.push({ type: "qmark", value: ch });
      i++;
      continue;
    }
    if (ch === ":") {
      tokens.push({ type: "colon", value: ch });
      i++;
      continue;
    }

    // Disallowed character (e.g. ;, [, ], {, }, ", ', `, \, $, etc.)
    return null;
  }

  return tokens.length > 0 ? tokens : null;
}

class Parser {
  private pos = 0;
  private depth = 0;
  private readonly tokens: Token[];
  private readonly vars: Record<string, number>;

  constructor(tokens: Token[], vars: Record<string, number>) {
    this.tokens = tokens;
    const safeVars: Record<string, number> = Object.create(null);
    for (const [k, v] of Object.entries(vars)) {
      if (
        !FORBIDDEN_IDENTIFIERS.has(k.toLowerCase()) &&
        typeof v === "number" &&
        Number.isFinite(v)
      ) {
        safeVars[k] = v;
        safeVars[k.toLowerCase()] = v;
      }
    }
    this.vars = safeVars;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    return this.tokens[this.pos++];
  }

  private enter(): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) {
      throw new Error("Expression depth limit exceeded");
    }
  }

  private leave(): void {
    this.depth--;
  }

  parse(): number {
    const val = this.parseTernary();
    if (this.pos !== this.tokens.length) {
      throw new Error("Unexpected trailing token");
    }
    return val;
  }

  private parseTernary(): number {
    this.enter();
    try {
      const cond = this.parseComparison();
      if (this.peek()?.type === "qmark") {
        this.consume();
        const yes = this.parseTernary();
        if (this.peek()?.type !== "colon") {
          throw new Error("Expected ':' in ternary");
        }
        this.consume();
        const no = this.parseTernary();
        return cond ? yes : no;
      }
      return cond;
    } finally {
      this.leave();
    }
  }

  private parseComparison(): number {
    let left = this.parseAddSub();
    while (
      this.peek()?.type === "op" &&
      ["<", "<=", ">", ">=", "==", "!="].includes(this.peek()!.value)
    ) {
      const op = this.consume().value;
      const right = this.parseAddSub();
      if (op === "<") left = left < right ? 1 : 0;
      else if (op === "<=") left = left <= right ? 1 : 0;
      else if (op === ">") left = left > right ? 1 : 0;
      else if (op === ">=") left = left >= right ? 1 : 0;
      else if (op === "==") left = Math.abs(left - right) < 1e-9 ? 1 : 0;
      else if (op === "!=") left = Math.abs(left - right) >= 1e-9 ? 1 : 0;
    }
    return left;
  }

  private parseAddSub(): number {
    let left = this.parseMulDiv();
    while (
      this.peek()?.type === "op" &&
      (this.peek()!.value === "+" || this.peek()!.value === "-")
    ) {
      const op = this.consume().value;
      const right = this.parseMulDiv();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  private parseMulDiv(): number {
    let left = this.parseUnary();
    while (
      this.peek()?.type === "op" &&
      (this.peek()!.value === "*" ||
        this.peek()!.value === "/" ||
        this.peek()!.value === "%")
    ) {
      const op = this.consume().value;
      const right = this.parseUnary();
      if (op === "*") left = left * right;
      else if (op === "/") left = right === 0 ? NaN : left / right;
      else left = right === 0 ? NaN : left % right;
    }
    return left;
  }

  private parseUnary(): number {
    this.enter();
    try {
      if (
        this.peek()?.type === "op" &&
        (this.peek()!.value === "+" || this.peek()!.value === "-")
      ) {
        const op = this.consume().value;
        const val = this.parseUnary();
        return op === "-" ? -val : val;
      }
      return this.parsePower();
    } finally {
      this.leave();
    }
  }

  private parsePower(): number {
    const base = this.parsePrimary();
    if (this.peek()?.type === "op" && this.peek()!.value === "^") {
      this.consume();
      const exp = this.parseUnary();
      return Math.pow(base, exp);
    }
    return base;
  }

  private parsePrimary(): number {
    this.enter();
    try {
      const tok = this.peek();
      if (!tok) throw new Error("Unexpected end of expression");

      if (tok.type === "num") {
        this.consume();
        return Number(tok.value);
      }

      if (tok.type === "paren" && tok.value === "(") {
        this.consume();
        const inner = this.parseTernary();
        const close = this.peek();
        if (!close || close.type !== "paren" || close.value !== ")") {
          throw new Error("Unclosed parenthesis");
        }
        this.consume();
        return inner;
      }

      if (tok.type === "ident") {
        this.consume();
        const name = tok.value;
        const lower = name.toLowerCase();

        // Function call
        if (this.peek()?.type === "paren" && this.peek()!.value === "(") {
          const fn = Object.hasOwn(FUNCTIONS, lower) ? FUNCTIONS[lower] : null;
          if (!fn) throw new Error(`Unknown function: ${name}`);
          this.consume(); // '('
          const args: number[] = [];
          if (!(this.peek()?.type === "paren" && this.peek()!.value === ")")) {
            while (true) {
              args.push(this.parseTernary());
              if (this.peek()?.type === "comma") {
                this.consume();
                continue;
              }
              break;
            }
          }
          const close = this.peek();
          if (!close || close.type !== "paren" || close.value !== ")") {
            throw new Error("Unclosed function call");
          }
          this.consume();
          return fn(...args);
        }

        // Variable lookup (exact match first, then lowercase)
        if (Object.hasOwn(this.vars, name)) return this.vars[name];
        if (Object.hasOwn(this.vars, lower)) return this.vars[lower];
        if (Object.hasOwn(CONSTANTS, lower)) return CONSTANTS[lower];
        throw new Error(`Unknown variable: ${name}`);
      }

      throw new Error(`Unexpected token: ${tok.value}`);
    } finally {
      this.leave();
    }
  }
}

/**
 * Evaluates a safe mathematical formula with the provided numeric variables.
 * Returns `null` if the expression is unsafe, malformed, or evaluates to NaN/Infinity.
 */
export function safeEvaluateMath(
  expr: string,
  variables: Record<string, number> = {},
): number | null {
  const tokens = tokenize(expr.trim());
  if (!tokens) return null;
  try {
    const parser = new Parser(tokens, variables);
    const result = parser.parse();
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Validates that a formula parses cleanly against a set of sample variable bindings.
 */
export function validateMathFormula(
  expr: string,
  sampleVariables: Record<string, number> = {},
): boolean {
  if (typeof expr !== "string" || !expr.trim()) return false;
  const tokens = tokenize(expr.trim());
  if (!tokens) return false;
  try {
    const parser = new Parser(tokens, sampleVariables);
    const val = parser.parse();
    return typeof val === "number";
  } catch {
    return false;
  }
}
