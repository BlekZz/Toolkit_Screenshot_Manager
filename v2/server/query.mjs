/**
 * Filter query language (Sprint §5): string syntax ⇄ JSON AST → parameterised SQL.
 *
 * AST nodes:
 *   {op:'all'} | {op:'and'|'or', args:[node...]} | {op:'not', arg:node}
 *   {op:'tag', id, exact?} | {op:'album', id} | {op:'smart', id}
 *   {op:'has', what:'album'|'tag'|'crop'|'ocr'} | {op:'text', q}
 *   {op:'date', from, to} (inclusive local-date prefixes) | {op:'ext', value}
 *   {op:'status', value} | {op:'rating', cmp, value}
 *
 * The compiler never interpolates user values into SQL — every value is a
 * bound parameter; only fixed fragments chosen from whitelists are concatenated.
 */

const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

const HAS = {
  album: 'EXISTS (SELECT 1 FROM album_items x WHERE x.asset_id = a.id)',
  tag: 'EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id)',
  crop: 'EXISTS (SELECT 1 FROM crops c WHERE c.asset_id = a.id)',
  ocr: 'EXISTS (SELECT 1 FROM ocr_results o WHERE o.asset_id = a.id)',
};
const STATUSES = new Set(['active', 'trashed', 'missing']);
const EXT_ALIASES = { jpg: ['jpg', 'jpeg'], jpeg: ['jpg', 'jpeg'] };
const CMPS = new Set(['>=', '<=', '>', '<', '=']);
const MAX_SMART_DEPTH = 8;

// ---- tokenizer / parser ----------------------------------------------------

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { tokens.push({ type: ch }); i++; continue; }
    if (ch === '-' && i + 1 < input.length && !/[\s()]/.test(input[i + 1])) {
      tokens.push({ type: 'NOT' }); i++; continue;
    }
    // A term: key:value, key:"quoted value", "quoted text", or a bare word.
    // `colon` is the key separator only if it appears unquoted before any quote.
    let raw = '';
    let quoted = false;
    let colon = -1;
    while (i < input.length && !/[\s()]/.test(input[i])) {
      if (input[i] === '"') {
        // Inside quotes, \" is a literal quote and \\ a literal backslash.
        let j = i + 1;
        let closed = false;
        while (j < input.length) {
          if (input[j] === '\\' && (input[j + 1] === '"' || input[j + 1] === '\\')) { raw += input[j + 1]; j += 2; continue; }
          if (input[j] === '"') { closed = true; break; }
          raw += input[j++];
        }
        if (!closed) throw bad('unterminated quote');
        quoted = true;
        i = j + 1;
      } else {
        if (input[i] === ':' && colon < 0 && !quoted) colon = raw.length;
        raw += input[i++];
      }
    }
    const upper = raw.toUpperCase();
    if (!quoted && (upper === 'AND' || upper === 'OR' || upper === 'NOT')) tokens.push({ type: upper });
    else tokens.push({ type: 'TERM', raw, colon });
  }
  return tokens;
}

/**
 * Parses the string syntax into an AST, resolving album/tag/smart names.
 *
 * Grammar: or := and (OR and)* ; and := unary ((AND)? unary)* ;
 *          unary := NOT unary | '(' or ')' | term
 *
 * @param {string} input
 * @param {{resolveTag: (path: string) => number[], resolveAlbum: (name: string) => number[],
 *   resolveSmart: (name: string) => number[]}} resolver
 * @returns {object} AST
 */
export function parseQuery(input, resolver) {
  const tokens = tokenize(input ?? '');
  if (!tokens.length) return { op: 'all' };
  let pos = 0;
  const peek = () => tokens[pos];

  function parseOr() {
    const args = [parseAnd()];
    while (peek()?.type === 'OR') { pos++; args.push(parseAnd()); }
    return args.length === 1 ? args[0] : { op: 'or', args };
  }
  function parseAnd() {
    const args = [parseUnary()];
    for (;;) {
      const t = peek();
      if (!t || t.type === 'OR' || t.type === ')') break;
      if (t.type === 'AND') pos++;
      args.push(parseUnary());
    }
    return args.length === 1 ? args[0] : { op: 'and', args };
  }
  function parseUnary() {
    const t = tokens[pos++];
    if (!t) throw bad('unexpected end of query');
    if (t.type === 'NOT') return { op: 'not', arg: parseUnary() };
    if (t.type === '(') {
      const inner = parseOr();
      if (tokens[pos++]?.type !== ')') throw bad('missing )');
      return inner;
    }
    if (t.type === 'TERM') return parseTerm(t, resolver);
    throw bad(`unexpected ${t.type}`);
  }

  const ast = parseOr();
  if (pos < tokens.length) throw bad(`unexpected ${tokens[pos].type}`);
  return ast;
}

function anyOf(nodes) {
  return nodes.length === 1 ? nodes[0] : { op: 'or', args: nodes };
}

function parseTerm({ raw, colon }, resolver) {
  if (colon <= 0) return { op: 'text', q: raw };
  const key = raw.slice(0, colon).toLowerCase();
  const value = raw.slice(colon + 1);
  if (!value) throw bad(`empty value for ${key}:`);
  const byId = /^#(\d+)$/.exec(value);

  switch (key) {
    case 'tag': {
      const exact = value.startsWith('=');
      const v = exact ? value.slice(1) : value;
      const idMatch = /^#(\d+)$/.exec(v);
      const ids = idMatch ? [Number(idMatch[1])] : resolver.resolveTag(v);
      if (!ids.length) throw bad(`unknown tag: ${v}`);
      return anyOf(ids.map((id) => ({ op: 'tag', id, ...(exact ? { exact: true } : {}) })));
    }
    case 'album': {
      const ids = byId ? [Number(byId[1])] : resolver.resolveAlbum(value);
      if (!ids.length) throw bad(`unknown album: ${value}`);
      return anyOf(ids.map((id) => ({ op: 'album', id })));
    }
    case 'smart': {
      const ids = byId ? [Number(byId[1])] : resolver.resolveSmart(value);
      if (!ids.length) throw bad(`unknown smart album: ${value}`);
      return anyOf(ids.map((id) => ({ op: 'smart', id })));
    }
    case 'has':
      if (!HAS[value]) throw bad(`has: expects ${Object.keys(HAS).join('|')}`);
      return { op: 'has', what: value };
    case 'text': return { op: 'text', q: value };
    case 'ext': return { op: 'ext', value: value.toLowerCase() };
    case 'status':
      if (!STATUSES.has(value)) throw bad(`status: expects ${[...STATUSES].join('|')}`);
      return { op: 'status', value };
    case 'date': {
      const [from, to = from] = value.split('..');
      for (const d of [from, to]) if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(d)) throw bad(`bad date: ${d}`);
      return { op: 'date', from, to };
    }
    case 'rating': {
      const m = /^(>=|<=|>|<|=)?(\d)$/.exec(value);
      if (!m) throw bad('rating: expects e.g. >=3');
      return { op: 'rating', cmp: m[1] ?? '=', value: Number(m[2]) };
    }
    default:
      throw bad(`unknown key: ${key}`);
  }
}

// ---- compiler ----------------------------------------------------------------

/** Exclusive upper bound for a yyyy[-mm[-dd]] prefix, as a comparable string. */
function nextPrefix(d) {
  const [y, m, day] = d.split('-').map(Number);
  if (day) {
    const n = new Date(Date.UTC(y, m - 1, day + 1));
    return n.toISOString().slice(0, 10);
  }
  if (m) return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return String(y + 1);
}

/**
 * Compiles an AST to a WHERE fragment over `assets a`.
 *
 * @param {object} ast
 * @param {{tagSubtree: (id: number) => number[], smartAst: (id: number) => object|null}} ctx
 * @returns {{sql: string, params: any[], mentionsStatus: boolean}}
 */
export function compileQuery(ast, ctx) {
  const params = [];
  let mentionsStatus = false;

  function walk(node, depth) {
    if (!node || typeof node !== 'object') throw bad('invalid query node');
    switch (node.op) {
      case 'all': return '1';
      case 'and':
      case 'or': {
        if (!Array.isArray(node.args)) throw bad(`${node.op} needs args`);
        if (!node.args.length) return node.op === 'and' ? '1' : '0';
        return `(${node.args.map((n) => walk(n, depth)).join(node.op === 'and' ? ' AND ' : ' OR ')})`;
      }
      case 'not': return `NOT (${walk(node.arg, depth)})`;
      case 'tag': {
        const id = Number(node.id);
        if (!Number.isInteger(id)) throw bad('tag id must be an integer');
        const ids = node.exact ? [id] : ctx.tagSubtree(id);
        if (!ids.length) return '0';
        params.push(...ids);
        return `EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag_id IN (${ids.map(() => '?').join(',')}))`;
      }
      case 'album': {
        const id = Number(node.id);
        if (!Number.isInteger(id)) throw bad('album id must be an integer');
        params.push(id);
        return 'EXISTS (SELECT 1 FROM album_items x WHERE x.asset_id = a.id AND x.album_id = ?)';
      }
      case 'smart': {
        if (depth >= MAX_SMART_DEPTH) throw bad('smart album nesting too deep (cycle?)');
        const inner = ctx.smartAst(Number(node.id));
        if (!inner) throw bad(`unknown smart album #${node.id}`);
        return `(${walk(inner, depth + 1)})`;
      }
      case 'has':
        if (!HAS[node.what]) throw bad('invalid has:');
        return HAS[node.what];
      case 'text': {
        const q = String(node.q ?? '').trim();
        if (!q) return '1';
        const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        params.push(like, like, like);
        // Filename + OCR text + bundle-independent note. FTS ranking arrives with P3.
        return `(a.filename LIKE ? ESCAPE '\\' OR a.note LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM ocr_results o WHERE o.asset_id = a.id AND o.cleaned_text LIKE ? ESCAPE '\\'))`;
      }
      case 'ext': {
        const values = EXT_ALIASES[node.value] ?? [String(node.value)];
        params.push(...values);
        return `a.ext IN (${values.map(() => '?').join(',')})`;
      }
      case 'status':
        if (!STATUSES.has(node.value)) throw bad('invalid status');
        mentionsStatus = true;
        params.push(node.value);
        return 'a.status = ?';
      case 'date': {
        const re = /^\d{4}(-\d{2}(-\d{2})?)?$/;
        if (!re.test(node.from) || !re.test(node.to)) throw bad('invalid date');
        params.push(node.from, nextPrefix(node.to));
        // Local calendar date of the file time (server TZ), compared as text prefix.
        return "(datetime(a.file_mtime, 'localtime') >= ? AND datetime(a.file_mtime, 'localtime') < ?)";
      }
      case 'rating': {
        if (!CMPS.has(node.cmp)) throw bad('invalid rating comparator');
        params.push(Number(node.value));
        return `COALESCE(a.rating, 0) ${node.cmp} ?`;
      }
      default:
        throw bad(`unknown op: ${node.op}`);
    }
  }

  const sql = walk(ast, 0);
  return { sql, params, mentionsStatus };
}

/**
 * Builds the full WHERE clause, hiding trashed/missing assets unless the
 * query talks about status explicitly.
 */
export function whereClause(ast, ctx) {
  const { sql, params, mentionsStatus } = compileQuery(ast, ctx);
  return { sql: mentionsStatus ? sql : `a.status = 'active' AND (${sql})`, params };
}
