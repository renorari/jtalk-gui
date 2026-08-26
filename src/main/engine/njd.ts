// Parses the "[Text analysis result]" block that `open_jtalk -ot` writes, which is
// NJDNode_fprint's output: one morpheme per line, 13 comma-separated fields.

import type { NjdNode } from '../../shared/types';

const FIELDS = [
  'string', 'pos', 'posGroup1', 'posGroup2', 'posGroup3',
  'ctype', 'cform', 'orig', 'read', 'pron',
] as const;

export function parseTextAnalysis(trace: string): NjdNode[] {
  const start = trace.indexOf('[Text analysis result]');
  if (start < 0) return [];
  const end = trace.indexOf('[Output label]', start);
  const block = trace.slice(start + '[Text analysis result]'.length, end < 0 ? undefined : end);

  const nodes: NjdNode[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 13) continue;

    // The surface form can itself contain a comma (the "," symbol is a morpheme),
    // so anchor on the right: the last three fields are acc/mora, chain_rule, chain_flag.
    const chainFlagRaw = parseInt(parts[parts.length - 1], 10);
    const chainRule = parts[parts.length - 2];
    const accMora = parts[parts.length - 3];
    const head = parts.slice(0, parts.length - 3);
    // Fold any surplus leading fields back into `string`.
    while (head.length > FIELDS.length) { head[0] = head[0] + ',' + head[1]; head.splice(1, 1); }

    const node = {} as NjdNode;
    FIELDS.forEach((name, i) => { (node as unknown as Record<string, string>)[name] = head[i] ?? ''; });
    const [acc, moraSize] = accMora.split('/');
    node.acc = parseInt(acc, 10) || 0;
    node.moraSize = parseInt(moraSize, 10) || 0;
    node.chainRule = chainRule;
    node.chainFlag = Number.isNaN(chainFlagRaw) ? -1 : chainFlagRaw;
    nodes.push(node);
  }
  return nodes;
}

/** Extract the label strings from the "[Output label]" block; used by the tests. */
export function parseOutputLabel(trace: string): string[] {
  const start = trace.indexOf('[Output label]');
  if (start < 0) return [];
  const block = trace.slice(start + '[Output label]'.length);
  const out: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) { if (out.length) break; continue; }
    const m = line.match(/^\d+\s+\d+\s+(\S+)$/);
    if (m) out.push(m[1]);
    else if (out.length) break;
  }
  return out;
}
