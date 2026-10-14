/**
 * The frontmatter of a skill node's body, read on the client without a YAML
 * dependency. A skill is a typed prompt template: the API
 * (`src/lib/skills/template.ts :: SkillFrontmatter`) parses the same block
 * with gray-matter to run it; the web only needs to SHOW it — the version
 * lives on `data.version`, the declared inputs, the model pin, the system
 * prompt — so this reads the YAML subset skills are written in (scalars,
 * block scalars, nested maps, lists of scalars and of maps) and never
 * writes it back. `skill-node-view.tsx` renders the result above the
 * editable body; anything this parser cannot read comes back as `{}` with
 * the whole text as the body, which is the same fallback the API uses.
 */

export interface SkillInputField {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  default?: unknown;
  description?: string;
}

export interface SkillToolRef {
  name: string;
  op?: string;
  when?: string;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  title?: string;
  scopes?: string[];
  tools?: SkillToolRef[];
  model?: string;
  fields: SkillInputField[];
  system?: string;
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  /** The prompt template after the frontmatter block, leading blank lines dropped. */
  body: string;
  /** Whether a frontmatter block was found at all. */
  hasFrontmatter: boolean;
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

const FENCE = /^---\s*$/;

/** Split `---` frontmatter from the body; `data` is `{}` when there is none. */
export function splitFrontmatter(raw: string): { yaml: string | null; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0 || !FENCE.test(lines[0] ?? "")) return { yaml: null, body: raw };
  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line));
  if (end === -1) return { yaml: null, body: raw };
  return {
    yaml: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n").replace(/^\n+/, ""),
  };
}

export function parseSkillBody(raw: string): ParsedSkill {
  const { yaml, body } = splitFrontmatter(raw);
  if (yaml === null) return { frontmatter: { fields: [] }, body, hasFrontmatter: false };
  let data: YamlValue;
  try {
    data = parseYaml(yaml);
  } catch {
    return { frontmatter: { fields: [] }, body: raw, hasFrontmatter: false };
  }
  return { frontmatter: readFrontmatter(data), body, hasFrontmatter: true };
}

function readFrontmatter(data: YamlValue): SkillFrontmatter {
  const map = isMap(data) ? data : {};
  const schema = isMap(map.input_schema) ? map.input_schema : {};
  const rawFields = Array.isArray(schema.fields) ? schema.fields : [];
  const fields: SkillInputField[] = [];
  for (const entry of rawFields) {
    if (!isMap(entry) || typeof entry.name !== "string") continue;
    const type = entry.type === "number" || entry.type === "boolean" ? entry.type : "string";
    fields.push({
      name: entry.name,
      type,
      required: entry.required === true,
      ...(entry.default !== undefined && entry.default !== null ? { default: entry.default } : {}),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    });
  }
  const tools: SkillToolRef[] = [];
  if (Array.isArray(map.tools)) {
    for (const entry of map.tools) {
      if (typeof entry === "string") tools.push({ name: entry });
      else if (isMap(entry) && typeof entry.name === "string") {
        tools.push({
          name: entry.name,
          ...(typeof entry.op === "string" ? { op: entry.op } : {}),
          ...(typeof entry.when === "string" ? { when: entry.when } : {}),
        });
      }
    }
  }
  const scopes = Array.isArray(map.scopes)
    ? map.scopes.filter((scope): scope is string => typeof scope === "string")
    : undefined;
  return {
    ...(typeof map.name === "string" ? { name: map.name } : {}),
    ...(typeof map.description === "string" ? { description: map.description } : {}),
    ...(typeof map.title === "string" ? { title: map.title } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(typeof map.model === "string" ? { model: map.model } : {}),
    ...(typeof map.system === "string" ? { system: map.system } : {}),
    fields,
  };
}

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// A small indentation-driven YAML reader. It handles what skill frontmatter
// uses and refuses (throws) on anything it cannot place, so the caller can
// fall back rather than show a half-read schema.

interface Line {
  indent: number;
  text: string;
}

function toLines(yaml: string): Line[] {
  const out: Line[] = [];
  for (const raw of yaml.split("\n")) {
    const withoutComment = raw.trimStart().startsWith("#") ? "" : raw;
    if (withoutComment.trim() === "") {
      // Blank lines matter inside block scalars only; keep them with a
      // sentinel indent so the scalar reader can see them.
      out.push({ indent: -1, text: "" });
      continue;
    }
    const indent = withoutComment.length - withoutComment.trimStart().length;
    out.push({ indent, text: withoutComment.trimEnd() });
  }
  return out;
}

function parseYaml(yaml: string): YamlValue {
  const lines = toLines(yaml);
  const content = lines.filter((line) => line.indent >= 0);
  if (content.length === 0) return {};
  const [value] = parseNode(lines, 0, content[0]!.indent);
  return value;
}

/** Parse the block starting at `start` whose lines sit at `indent`; returns the value and the next line index. */
function parseNode(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const first = nextContent(lines, start);
  if (first === -1) return [null, lines.length];
  const line = lines[first]!;
  if (line.indent !== indent) throw new Error("bad indentation");
  return line.text.slice(line.indent).startsWith("- ") || line.text.trim() === "-"
    ? parseSequence(lines, first, indent)
    : parseMapping(lines, first, indent);
}

function nextContent(lines: Line[], from: number): number {
  for (let index = from; index < lines.length; index++) {
    if (lines[index]!.indent >= 0) return index;
  }
  return -1;
}

function parseMapping(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const out: { [key: string]: YamlValue } = {};
  let index = start;
  while (index < lines.length) {
    const at = nextContent(lines, index);
    if (at === -1) return [out, lines.length];
    const line = lines[at]!;
    if (line.indent < indent) return [out, at];
    if (line.indent > indent) throw new Error("unexpected indentation");
    const text = line.text.slice(indent);
    const colon = findKeyColon(text);
    if (colon === -1) throw new Error("expected a key");
    const key = unquote(text.slice(0, colon).trim());
    const rest = text.slice(colon + 1).trim();
    const [value, next] = parseValue(lines, at, indent, rest);
    out[key] = value;
    index = next;
  }
  return [out, index];
}

function parseSequence(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const out: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const at = nextContent(lines, index);
    if (at === -1) return [out, lines.length];
    const line = lines[at]!;
    if (line.indent < indent) return [out, at];
    if (line.indent > indent) throw new Error("unexpected indentation");
    const text = line.text.slice(indent);
    if (!(text.startsWith("- ") || text === "-")) return [out, at];
    const rest = text.slice(1).trim();
    if (rest === "") {
      const [value, next] = parseNode(lines, at + 1, childIndent(lines, at + 1, indent));
      out.push(value);
      index = next;
      continue;
    }
    const colon = findKeyColon(rest);
    if (colon !== -1 && !rest.startsWith("[") && !rest.startsWith("\"") && !rest.startsWith("'")) {
      // "- name: x" starts a mapping whose first key sits on the dash line;
      // the following keys are indented past the dash (by two, unless the
      // author aligned them differently).
      const following = nextContent(lines, at + 1);
      const itemIndent = following !== -1 && lines[following]!.indent > indent ? lines[following]!.indent : indent + 2;
      const synthetic: Line = { indent: itemIndent, text: " ".repeat(itemIndent) + rest };
      const spliced = [...lines.slice(0, at), synthetic, ...lines.slice(at + 1)];
      const [value, next] = parseMapping(spliced, at, itemIndent);
      out.push(value);
      index = next;
      // `spliced` has the same length as `lines`, so `next` maps 1:1.
      continue;
    }
    out.push(parseScalar(rest));
    index = at + 1;
  }
  return [out, index];
}

function childIndent(lines: Line[], from: number, parentIndent: number): number {
  const at = nextContent(lines, from);
  if (at === -1 || lines[at]!.indent <= parentIndent) throw new Error("expected a nested block");
  return lines[at]!.indent;
}

function parseValue(lines: Line[], at: number, indent: number, rest: string): [YamlValue, number] {
  if (rest === "") {
    const next = nextContent(lines, at + 1);
    if (next === -1 || lines[next]!.indent <= indent) return [null, at + 1];
    return parseNode(lines, at + 1, lines[next]!.indent);
  }
  if (/^[|>][+-]?$/.test(rest)) return parseBlockScalar(lines, at + 1, indent, rest[0] === ">", rest.endsWith("-") ? "strip" : rest.endsWith("+") ? "keep" : "clip");
  return [parseScalar(rest), at + 1];
}

function parseBlockScalar(lines: Line[], start: number, parentIndent: number, fold: boolean, chomp: "strip" | "keep" | "clip"): [YamlValue, number] {
  const collected: string[] = [];
  let index = start;
  let blockIndent: number | null = null;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent === -1) {
      collected.push("");
      index += 1;
      continue;
    }
    if (line.indent <= parentIndent) break;
    if (blockIndent === null) blockIndent = line.indent;
    collected.push(line.text.slice(Math.min(blockIndent, line.indent)));
    index += 1;
  }
  // Trailing blank lines belong to the chomping indicator, not the text.
  let trailing = 0;
  while (collected.length > 0 && collected[collected.length - 1] === "") {
    collected.pop();
    trailing += 1;
  }
  let text = fold
    ? collected.reduce((acc, current, position) => {
        if (position === 0) return current;
        const previous = collected[position - 1]!;
        if (current === "" || previous === "") return `${acc}\n${current}`;
        return `${acc} ${current}`;
      }, "")
    : collected.join("\n");
  if (chomp === "keep") text += "\n".repeat(trailing + 1);
  else if (chomp === "clip" && collected.length > 0) text += "\n";
  return [text, index];
}

function findKeyColon(text: string): number {
  if (text.startsWith("\"") || text.startsWith("'")) {
    const quote = text[0]!;
    const close = text.indexOf(quote, 1);
    if (close === -1) return -1;
    const colon = text.indexOf(":", close);
    return colon;
  }
  for (let index = 0; index < text.length; index++) {
    if (text[index] === ":" && (index === text.length - 1 || text[index + 1] === " ")) return index;
  }
  return -1;
}

function parseScalar(text: string): YamlValue {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner === "" ? [] : splitFlow(inner).map((item) => parseScalar(item));
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    const out: { [key: string]: YamlValue } = {};
    if (inner === "") return out;
    for (const pair of splitFlow(inner)) {
      const colon = findKeyColon(pair);
      if (colon === -1) throw new Error("bad flow mapping");
      out[unquote(pair.slice(0, colon).trim())] = parseScalar(pair.slice(colon + 1));
    }
    return out;
  }
  if (trimmed.startsWith("\"") || trimmed.startsWith("'")) return unquote(trimmed);
  if (trimmed === "" || trimmed === "~" || trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; current += char; continue; }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    if (char === "," && depth === 0) { out.push(current.trim()); current = ""; continue; }
    current += char;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    return text.slice(1, -1).replace(/\\(["\\nt])/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char));
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}
