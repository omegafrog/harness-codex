function stripComment(line) {
  let quoted = false;
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if ((char === "'" || char === '"') && (i === 0 || line[i - 1] !== "\\")) {
      if (!quoted) {
        quoted = true;
        quote = char;
      } else if (quote === char) {
        quoted = false;
      }
    }
    if (char === "#" && !quoted && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function splitTopLevel(text, separator = ",") {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if ((char === "'" || char === '"') && text[i - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (!quote) {
      if (char === "[" || char === "{") depth += 1;
      if (char === "]" || char === "}") depth -= 1;
      if (char === separator && depth === 0) {
        parts.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function findColon(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if ((char === "'" || char === '"') && text[i - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (!quote) {
      if (char === "[" || char === "{") depth += 1;
      if (char === "]" || char === "}") depth -= 1;
      if (char === ":" && depth === 0) return i;
    }
  }
  return -1;
}

function parseScalar(value) {
  const text = value.trim();
  if (!text) return null;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    if (text.startsWith('"')) return JSON.parse(text);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      return JSON.parse(text);
    } catch {
      return splitTopLevel(text.slice(1, -1)).map(parseScalar);
    }
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      return JSON.parse(text);
    } catch {
      const object = {};
      for (const pair of splitTopLevel(text.slice(1, -1))) {
        const colon = findColon(pair);
        if (colon < 0) continue;
        object[pair.slice(0, colon).trim().replace(/^['"]|['"]$/g, "")] = parseScalar(pair.slice(colon + 1));
      }
      return object;
    }
  }
  return text;
}

function parseBlock(lines, start, indent) {
  const isList = lines[start]?.indent === indent && lines[start].text.startsWith("-");
  const value = isList ? [] : {};
  let index = start;
  while (index < lines.length && lines[index].indent === indent) {
    const line = lines[index].text;
    if (isList) {
      if (!line.startsWith("-")) break;
      const rest = line.slice(1).trim();
      if (!rest) {
        if (index + 1 < lines.length && lines[index + 1].indent > indent) {
          const child = parseBlock(lines, index + 1, lines[index + 1].indent);
          value.push(child.value);
          index = child.index;
        } else {
          value.push(null);
          index += 1;
        }
        continue;
      }
      const colon = findColon(rest);
      if (colon < 0) {
        value.push(parseScalar(rest));
        index += 1;
        continue;
      }
      const item = {};
      const key = rest.slice(0, colon).trim().replace(/^['"]|['"]$/g, "");
      const raw = rest.slice(colon + 1).trim();
      index += 1;
      if (raw) {
        item[key] = parseScalar(raw);
      } else if (index < lines.length && lines[index].indent > indent) {
        const child = parseBlock(lines, index, lines[index].indent);
        item[key] = child.value;
        index = child.index;
      } else {
        item[key] = null;
      }
      while (index < lines.length && lines[index].indent > indent) {
        const childIndent = lines[index].indent;
        const childLine = lines[index].text;
        if (childLine.startsWith("-")) break;
        const childColon = findColon(childLine);
        if (childColon < 0) throw new Error(`Invalid YAML mapping: ${childLine}`);
        const childKey = childLine.slice(0, childColon).trim().replace(/^['"]|['"]$/g, "");
        const childRaw = childLine.slice(childColon + 1).trim();
        index += 1;
        if (childRaw) {
          item[childKey] = parseScalar(childRaw);
        } else if (index < lines.length && lines[index].indent > childIndent) {
          const child = parseBlock(lines, index, lines[index].indent);
          item[childKey] = child.value;
          index = child.index;
        } else {
          item[childKey] = null;
        }
      }
      value.push(item);
      continue;
    }
    const colon = findColon(line);
    if (colon < 0) throw new Error(`Invalid YAML mapping: ${line}`);
    const key = line.slice(0, colon).trim().replace(/^['"]|['"]$/g, "");
    const raw = line.slice(colon + 1).trim();
    index += 1;
    if (raw) {
      value[key] = parseScalar(raw);
    } else if (index < lines.length && lines[index].indent > indent) {
      const child = parseBlock(lines, index, lines[index].indent);
      value[key] = child.value;
      index = child.index;
    } else {
      value[key] = null;
    }
  }
  return { value, index };
}

export function parseYaml(source) {
  const trimmed = source.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const lines = source.split(/\r?\n/).map(stripComment).filter((line) => line.trim()).map((line) => ({
    indent: line.search(/\S/),
    text: line.trim(),
  }));
  if (!lines.length) return {};
  return parseBlock(lines, 0, lines[0].indent).value;
}
