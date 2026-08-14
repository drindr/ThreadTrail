/**
 * Compact, dependency-free syntax highlighter for the panel: extension
 * detection, a per-line tokenizer with cross-line block-comment state, and a
 * helper to render a line's tokens as spans. Also used to highlight diff
 * lines in the op detail.
 */

import { createElement } from 'react';
import type { ReactElement } from 'react';

export interface Token {
  t: 'p' | 's' | 'c' | 'k' | 'n' | 'o';
  text: string;
}

export type HighlightLine = (line: string) => Token[];

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DQ = String.raw`"(?:[^"\\]|\\.)*"`;
const SQ = String.raw`'(?:[^'\\]|\\.)*'`;
const BT = String.raw`\`(?:[^\`\\]|\\.)*\``;
const STR = `${DQ}|${SQ}|${BT}`;
const NUM = String.raw`\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)\b`;
const PUNCT = String.raw`[\[\]{}()\.,;:=<>+\-*/%&|^!~?]+`;

const KW: Record<string, string> = {
  js: 'abstract arguments async await boolean break byte case catch char class const continue debugger default delete do double else enum eval export extends false final finally float for function get goto if implements import in instanceof int interface let long native new null of package private protected public return set short static super switch synchronized this throw throws transient true try typeof var void volatile while with yield',
  ts: 'abstract any as asserts async await bigint boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get global implements import in infer instanceof interface is keyof let module namespace never new null number of override package private protected public readonly require return set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield',
  python: 'False None True and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield',
  ruby: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while',
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while',
  cpp: 'alignas alignof and and_eq asm auto bitand bitor bool break case catch char class compl const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq',
  bash: 'case do done elif else esac fi for function if in select then time until while coproc return local declare readonly export unset eval exec exit set shopt test true false',
  sql: 'select from where insert into values update set delete create table alter drop index view join left right inner outer full cross on as and or not null primary key foreign references default unique check constraint group by order having limit offset union all distinct case when then else end exists between like in is',
  json: 'true false null',
  yaml: 'true false null yes no on off',
  toml: 'true false',
  css: '!important',
};

interface LangDef {
  line?: string;
  block?: [string, string];
  str: string;
  kw: string;
}

const LANG_DEFS: Record<string, LangDef> = {
  js: { line: String.raw`//[^\n]*`, block: ['/*', '*/'], str: STR, kw: KW.js },
  ts: { line: String.raw`//[^\n]*`, block: ['/*', '*/'], str: STR, kw: KW.ts },
  python: { line: String.raw`#[^\n]*`, str: STR, kw: KW.python },
  ruby: { line: String.raw`#[^\n]*`, str: STR, kw: KW.ruby },
  go: { line: String.raw`//[^\n]*`, block: ['/*', '*/'], str: STR, kw: KW.go },
  rust: { line: String.raw`//[^\n]*`, block: ['/*', '*/'], str: STR, kw: KW.rust },
  java: { line: String.raw`//[^\n]*`, block: ['/*', '*/'], str: STR, kw: KW.java },
  c: { line: String.raw`//[^\n]*`, block: ['/*', '*/'], str: STR, kw: KW.c },
  cpp: { line: String.raw`//[^\n]*`, block: ['/*', '*/'], str: STR, kw: KW.cpp },
  bash: { line: String.raw`#[^\n]*`, str: STR, kw: KW.bash },
  sql: { line: String.raw`--[^\n]*`, block: ['/*', '*/'], str: SQ, kw: KW.sql },
  json: { str: STR, kw: KW.json },
  yaml: { line: String.raw`#[^\n]*`, str: STR, kw: KW.yaml },
  toml: { line: String.raw`#[^\n]*`, str: STR, kw: KW.toml },
  css: { block: ['/*', '*/'], str: STR, kw: KW.css },
  html: { block: ['<!--', '-->'], str: DQ, kw: '' },
  text: { str: '', kw: '' },
};

const EXT_LANG: Record<string, string> = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', mts: 'ts',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', hh: 'cpp',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  css: 'css', scss: 'css', html: 'html', htm: 'html', vue: 'html', svelte: 'html', xml: 'html',
  txt: 'text', gitignore: 'text', env: 'text', md: 'text',
};

export function detectLang(path: string): string {
  const base = String(path || '').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const l = EXT_LANG[base.slice(dot + 1).toLowerCase()];
    if (l) return l;
  }
  if (base === 'Dockerfile' || base === 'Makefile' || base === 'Rakefile') return 'bash';
  return 'text';
}

interface CompiledConfig {
  re: RegExp;
  block: [string, string] | null;
}

/** Build a compiled tokenizer config for a language. */
function buildConfig(lang: string): CompiledConfig {
  const def = LANG_DEFS[lang] || LANG_DEFS.text;
  const kw = def.kw ? `(?:${def.kw.split(/\s+/).filter(Boolean).map(escRe).join('|')})` : '';
  const parts: string[] = [];
  if (def.str) parts.push(`(${def.str})`); // 1 string
  if (def.line) parts.push(`(${def.line})`); // 2 line comment
  if (kw) parts.push(`(\\b${kw}\\b)`); // 3 keyword
  parts.push(`(${NUM})`); // 4 number
  parts.push(`(${PUNCT})`); // 5 punct
  return {
    re: new RegExp(parts.join('|'), 'g'),
    block: def.block || null,
  };
}

const compiled = new Map<string, CompiledConfig>();
function configFor(lang: string): CompiledConfig {
  let c = compiled.get(lang);
  if (!c) {
    c = buildConfig(lang);
    compiled.set(lang, c);
  }
  return c;
}

/** Tokenize one line into {t, text} tokens. */
function tokenizeLine(text: string, cfg: CompiledConfig): Token[] {
  const out: Token[] = [];
  if (!text) return out;
  const re = cfg.re;
  re.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'p', text: text.slice(last, m.index) });
    const cls: Token['t'] = m[1] !== undefined ? 's' : m[2] !== undefined ? 'c' : m[3] !== undefined ? 'k' : m[4] !== undefined ? 'n' : 'o';
    out.push({ t: cls, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: 'p', text: text.slice(last) });
  return out;
}

/**
 * Per-file highlighter with block-comment state, so multi-line comments stay
 * colored across lines.
 */
export function createHighlighter(lang: string): HighlightLine {
  const cfg = configFor(lang);
  let inBlock = false;
  return function highlightLine(line: string): Token[] {
    if (line === '') return [{ t: 'p', text: '' }];
    if (!cfg.block) return tokenizeLine(line, cfg);
    const [bs, be] = cfg.block;
    let rest = line;
    const parts: Token[] = [];
    if (inBlock) {
      const i = rest.indexOf(be);
      if (i === -1) return [{ t: 'c', text: rest }];
      parts.push({ t: 'c', text: rest.slice(0, i + be.length) });
      rest = rest.slice(i + be.length);
      inBlock = false;
    }
    const s = rest.indexOf(bs);
    if (s === -1) {
      parts.push(...tokenizeLine(rest, cfg));
      return parts;
    }
    parts.push(...tokenizeLine(rest.slice(0, s), cfg));
    const e = rest.indexOf(be, s + bs.length);
    if (e === -1) {
      parts.push({ t: 'c', text: rest.slice(s) });
      inBlock = true;
      return parts;
    }
    parts.push({ t: 'c', text: rest.slice(s, e + be.length) });
    parts.push(...tokenizeLine(rest.slice(e + be.length), cfg));
    return parts;
  };
}

/** Render one line's tokens as spans (or a plain string when lang is text). */
export function renderTokens(tokens: Token[], keyPrefix: string): ReactElement[] {
  return tokens.map((tok, i) => (
    <span key={`${keyPrefix}-${i}`} className={tok.t === 'p' ? undefined : `ddb-tok-${tok.t}`}>
      {tok.text}
    </span>
  ));
}
