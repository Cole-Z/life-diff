const SEP = "__";
const TOOL_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function namespacedTool(upstream: string, tool: string): string | null {
  if (!TOOL_NAME.test(tool)) return null;
  const name = `${upstream}${SEP}${tool}`;
  if (name.length > 128) return null;
  return name;
}

export function splitNamespacedTool(name: string): { upstream: string; tool: string } | null {
  const index = name.indexOf(SEP);
  if (index <= 0) return null;
  const upstream = name.slice(0, index);
  const tool = name.slice(index + SEP.length);
  if (!upstream || !tool) return null;
  return { upstream, tool };
}
