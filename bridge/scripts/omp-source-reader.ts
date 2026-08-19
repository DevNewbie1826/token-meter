/**
 * Deterministic extraction of OMP registry facts from TypeScript sources,
 * using the TypeScript compiler's scanner (`typescript/unstable/ast`).
 *
 * TypeScript 7's npm package ships no text->AST parser (only a scanner and
 * node factories), so this module drives the compiler scanner directly to
 * extract exactly three constructs and nothing else:
 *
 *   1. named import declarations (local binding -> module specifier)
 *   2. `const NAME: T[] = [ ident, ... ]` identifier arrays
 *   3. a top-level `id:` property of an `export const NAME = { ... }` object,
 *      following a local `const X = "literal"` binding when referenced
 *
 * OMP code is never imported, evaluated or trusted; unknown syntax is
 * reported as "not found" and surfaces as a typed sync failure upstream.
 */

import { LanguageVariant, SyntaxKind, createScanner } from "typescript/unstable/ast";
import type { Scanner } from "typescript/unstable/ast";

type Token = {
  readonly kind: SyntaxKind;
  readonly text: string;
  readonly value: string;
};

const SCAN_LIMIT = 4096;

function tokenize(source: string): readonly Token[] {
  const scanner = createScanner(true, LanguageVariant.Standard);
  scanner.setText(source);
  const tokens: Token[] = [];
  let templateDepth = 0;
  for (;;) {
    const kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) {
      return tokens;
    }
    if (kind === SyntaxKind.TemplateHead) {
      templateDepth += 1;
      tokens.push(tokenFrom(scanner, kind));
      continue;
    }
    if (kind === SyntaxKind.CloseBraceToken && templateDepth > 0) {
      const rescanned = scanner.reScanTemplateToken(false);
      if (rescanned === SyntaxKind.TemplateTail) {
        templateDepth -= 1;
      }
      tokens.push(tokenFrom(scanner, rescanned));
      continue;
    }
    tokens.push(tokenFrom(scanner, kind));
  }
}

function tokenFrom(scanner: Scanner, kind: SyntaxKind): Token {
  return { kind, text: scanner.getTokenText(), value: scanner.getTokenValue() };
}

export function extractNamedImports(source: string): ReadonlyMap<string, string> {
  const tokens = tokenize(source);
  const imports = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.kind !== SyntaxKind.ImportKeyword) {
      continue;
    }
    if (tokens[i + 1]?.kind === SyntaxKind.TypeKeyword) {
      continue;
    }
    registerNamedBindings(tokens, i, imports);
  }
  return imports;
}

/** Registers `{ a, b as c }` locals of one import clause against its specifier. */
function registerNamedBindings(tokens: readonly Token[], importAt: number, imports: Map<string, string>): void {
  let clauseEnd = -1;
  let specifier: string | undefined;
  for (let j = importAt + 1; j < tokens.length && j - importAt < SCAN_LIMIT; j++) {
    const current = tokens[j];
    if (current === undefined || current.kind === SyntaxKind.FromKeyword) {
      clauseEnd = j;
      const literal = tokens[j + 1];
      if (literal?.kind === SyntaxKind.StringLiteral) {
        specifier = literal.value;
      }
      break;
    }
  }
  if (clauseEnd === -1 || specifier === undefined) {
    return;
  }
  let open = -1;
  for (let j = importAt + 1; j < clauseEnd; j++) {
    if (tokens[j]?.kind === SyntaxKind.OpenBraceToken) {
      open = j;
      break;
    }
  }
  if (open === -1) {
    return;
  }
  let segment: string[] = [];
  let renameNext = false;
  for (let j = open + 1; j < clauseEnd; j++) {
    const current = tokens[j];
    if (current === undefined) {
      break;
    }
    if (current.kind === SyntaxKind.Identifier) {
      segment = renameNext ? [current.text] : [...segment, current.text];
      renameNext = false;
      continue;
    }
    if (current.kind === SyntaxKind.AsKeyword) {
      renameNext = true;
      continue;
    }
    if (current.kind === SyntaxKind.CommaToken || current.kind === SyntaxKind.CloseBraceToken) {
      const local = segment.at(-1);
      if (local !== undefined) {
        imports.set(local, specifier);
      }
      segment = [];
      if (current.kind === SyntaxKind.CloseBraceToken) {
        return;
      }
    }
  }
}

export function extractIdentifierArray(source: string, variableName: string): readonly string[] | undefined {
  const tokens = tokenize(source);
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i]?.kind !== SyntaxKind.ConstKeyword || tokens[i + 1]?.text !== variableName) {
      continue;
    }
    const equals = indexOfKind(tokens, i + 2, SyntaxKind.EqualsToken);
    if (equals === undefined || tokens[equals + 1]?.kind !== SyntaxKind.OpenBracketToken) {
      return undefined;
    }
    const identifiers: string[] = [];
    let depth = 1;
    for (let j = equals + 2; j < tokens.length; j++) {
      const current = tokens[j];
      if (current === undefined) {
        break;
      }
      if (current.kind === SyntaxKind.OpenBracketToken) {
        depth += 1;
      } else if (current.kind === SyntaxKind.CloseBracketToken) {
        depth -= 1;
        if (depth === 0) {
          return identifiers;
        }
      } else if (current.kind === SyntaxKind.Identifier && depth === 1) {
        identifiers.push(current.text);
      }
    }
    return undefined;
  }
  return undefined;
}

export function extractObjectPropertyString(
  source: string,
  exportName: string,
  propertyName: string,
): string | undefined {
  const tokens = tokenize(source);
  for (let i = 2; i < tokens.length; i++) {
    if (
      tokens[i]?.kind !== SyntaxKind.Identifier ||
      tokens[i]?.text !== exportName ||
      tokens[i - 1]?.kind !== SyntaxKind.ConstKeyword ||
      tokens[i - 2]?.kind !== SyntaxKind.ExportKeyword
    ) {
      continue;
    }
    const equals = indexOfKind(tokens, i + 1, SyntaxKind.EqualsToken);
    if (equals === undefined || tokens[equals + 1]?.kind !== SyntaxKind.OpenBraceToken) {
      return undefined;
    }
    const property = objectPropertyToken(tokens, equals + 2, propertyName);
    if (property === undefined) {
      return undefined;
    }
    if (property.kind === SyntaxKind.StringLiteral) {
      return property.value;
    }
    if (property.kind === SyntaxKind.Identifier) {
      return localConstString(tokens, property.text);
    }
    return undefined;
  }
  return undefined;
}

function objectPropertyToken(tokens: readonly Token[], start: number, propertyName: string): Token | undefined {
  let depth = 1;
  for (let j = start; j < tokens.length; j++) {
    const current = tokens[j];
    if (current === undefined) {
      return undefined;
    }
    if (
      depth === 1 &&
      current.kind === SyntaxKind.Identifier &&
      current.text === propertyName &&
      tokens[j + 1]?.kind === SyntaxKind.ColonToken
    ) {
      return tokens[j + 2];
    }
    if (
      current.kind === SyntaxKind.OpenBraceToken ||
      current.kind === SyntaxKind.OpenBracketToken ||
      current.kind === SyntaxKind.OpenParenToken
    ) {
      depth += 1;
    } else if (
      current.kind === SyntaxKind.CloseBraceToken ||
      current.kind === SyntaxKind.CloseBracketToken ||
      current.kind === SyntaxKind.CloseParenToken
    ) {
      depth -= 1;
      if (depth === 0) {
        return undefined;
      }
    }
  }
  return undefined;
}

function localConstString(tokens: readonly Token[], identifier: string): string | undefined {
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i]?.kind !== SyntaxKind.ConstKeyword || tokens[i + 1]?.text !== identifier) {
      continue;
    }
    const equals = indexOfKind(tokens, i + 2, SyntaxKind.EqualsToken);
    const literal = equals === undefined ? undefined : tokens[equals + 1];
    return literal?.kind === SyntaxKind.StringLiteral ? literal.value : undefined;
  }
  return undefined;
}

function indexOfKind(tokens: readonly Token[], start: number, kind: SyntaxKind): number | undefined {
  for (let j = start; j < tokens.length && j - start < 32; j++) {
    if (tokens[j]?.kind === kind) {
      return j;
    }
  }
  return undefined;
}
