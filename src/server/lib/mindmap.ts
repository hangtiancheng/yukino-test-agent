/**
 * Mindmap service: four-level tree (module -> type -> case -> preconditions/
 * steps/expectations) + Markdown and XMind export.
 *
 * Node ids must be unique across the whole tree: the UI uses them as React
 * keys, so a repeated id silently drops siblings from the render.
 */
import { deflateRawSync } from "node:zlib";

import type { TestCaseRow } from "#/server/services/testcases";

export interface MindmapNode {
  id: string;
  title: string;
  children?: MindmapNode[];
}

export interface MindmapResult {
  tree: MindmapNode;
  statistics: { modules: number; types: number; cases: number; leaves: number };
}

const TYPE_LABELS: Record<string, string> = {
  positive: "Positive",
  negative: "Negative",
  boundary: "Boundary",
  state: "State Flow",
};

function countLeaves(node: MindmapNode): number {
  const children = node.children || [];
  if (children.length === 0) return 1;
  return children.reduce((sum, child) => sum + countLeaves(child), 0);
}

export function buildTree(
  projectName: string,
  cases: TestCaseRow[],
): MindmapResult {
  // module -> type -> cases
  const byModule = new Map<string, Map<string, TestCaseRow[]>>();
  for (const tc of cases) {
    const moduleName = tc.module || "Uncategorized";
    if (!byModule.has(moduleName)) byModule.set(moduleName, new Map());
    const types = byModule.get(moduleName)!;
    const list = types.get(tc.type) ?? [];
    list.push(tc);
    types.set(tc.type, list);
  }

  const modules: MindmapNode[] = [];
  for (const [moduleName, types] of byModule) {
    const typeNodes: MindmapNode[] = [];
    for (const [typeName, typeCases] of types) {
      const caseNodes: MindmapNode[] = typeCases.map((tc) => {
        const children: MindmapNode[] = [];
        tc.preconditions.forEach((pre, i) => {
          children.push({
            id: `pre-${tc.id}-${i}`,
            title: `Precondition: ${pre}`,
          });
        });
        const steps = tc.steps;
        if (steps.length > 0) {
          children.push({
            id: `steps-${tc.id}`,
            title: `Steps: ${steps.length}`,
            children: steps.map((s, i) => ({
              id: `s-${tc.id}-${i}`,
              title: `${i + 1}. ${s}`,
            })),
          });
        }
        tc.expectedResults.forEach((exp, i) => {
          children.push({ id: `exp-${tc.id}-${i}`, title: `Expected: ${exp}` });
        });
        return {
          id: `case-${tc.id}`,
          title: `${tc.id} ${tc.title}`,
          children,
        };
      });
      typeNodes.push({
        id: `type-${moduleName}-${typeName}`,
        title: TYPE_LABELS[typeName] ?? typeName,
        children: caseNodes,
      });
    }
    modules.push({
      id: `module-${moduleName}`,
      title: moduleName,
      children: typeNodes,
    });
  }

  const tree: MindmapNode = {
    id: "root",
    title: `${projectName} · Test Case Set (${cases.length})`,
    children: modules,
  };
  return {
    tree,
    statistics: {
      modules: modules.length,
      types: modules.reduce((sum, m) => sum + (m.children?.length ?? 0), 0),
      cases: cases.length,
      leaves: countLeaves(tree),
    },
  };
}

/** markmap-compatible indented list. */
export function exportMarkdown(result: MindmapResult): string {
  const lines: string[] = [];
  const walk = (node: MindmapNode, depth: number): void => {
    lines.push(`${"  ".repeat(depth)}- ${node.title}`);
    for (const child of node.children || []) walk(child, depth + 1);
  };
  walk(result.tree, 0);
  return lines.join("\n");
}

// ---------- XMind export ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Minimal ZIP writer (deflate method) so no extra dependency is needed. */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

function toXmindNode(node: MindmapNode): Record<string, unknown> {
  const out: Record<string, unknown> = { title: node.title };
  if (node.children && node.children.length > 0) {
    out.children = { attached: node.children.map(toXmindNode) };
  }
  return out;
}

/** XMind ZEN minimal structure: content.json + metadata.json + manifest.json. */
export function exportXmind(result: MindmapResult): Buffer {
  const content = JSON.stringify([toXmindNode(result.tree)]);
  const metadata = JSON.stringify({
    creator: { name: "Yukino Test Agent", version: "0.1.0" },
  });
  const manifest = JSON.stringify({
    "file-entries": { "content.json": {}, "metadata.json": {} },
  });
  return buildZip([
    { name: "content.json", data: Buffer.from(content, "utf8") },
    { name: "metadata.json", data: Buffer.from(metadata, "utf8") },
    { name: "manifest.json", data: Buffer.from(manifest, "utf8") },
  ]);
}
