import { fromJsonSchema, type McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { coreDeps } from "../app/runtime";
import { bindFetch } from "../bind-fetch";
import type { Env } from "../env";
import { listUpstreamTools, UPSTREAM_REDIRECT_MESSAGE, UpstreamRedirectError, type UpstreamTarget, type UpstreamToolInfo } from "../proxy/client";
import { clientName } from "./client-name";
import { forwardToolCall } from "../proxy/forward";
import { approvedUpstreamEndpoints, namespaceTool } from "../proxy/namespace";
import { loadTargets } from "../proxy/upstreams";
import { D1MetadataStore } from "../storage/d1";

const looseArgs = z.object({}).catchall(z.unknown());
const CACHE_MS = 60_000;
const ERROR_CACHE_MS = 10_000;

interface CacheEntry {
  at: number;
  tools: UpstreamToolInfo[];
  ttl: number;
  redirected?: boolean;
}

const catalog = new Map<string, CacheEntry>();

export function invalidateUpstreamCache(userId: string): void {
  for (const key of catalog.keys()) {
    if (key.startsWith(`${userId}\0`)) catalog.delete(key);
  }
}

export function clearUpstreamCache(): void {
  catalog.clear();
}

export function upstreamDiscoveryNotice(userId: string, target: { name: string; url: string }): string | undefined {
  const hit = catalogEntry(userId, target);
  return hit?.redirected ? UPSTREAM_REDIRECT_MESSAGE : undefined;
}

function catalogEntry(userId: string, target: { name: string; url: string }): CacheEntry | undefined {
  const hit = catalog.get(catalogKey(userId, target));
  return hit && Date.now() - hit.at < hit.ttl ? hit : undefined;
}

function catalogKey(userId: string, target: { name: string; url: string }): string {
  return `${userId}\0${target.name}\0${target.url}`;
}

export async function registerUpstreamTools(server: McpServer, env: Env, user: { userId: string; login: string }): Promise<void> {
  const endpoints = approvedUpstreamEndpoints(env);
  const targets = await loadTargets(new D1MetadataStore(env.DB), user.userId, env.TOKEN_ENCRYPTION_KEY, endpoints);
  const fetchImpl = bindFetch();
  const seen = new Set<string>();
  await Promise.all(targets.map(async (target) => {
    const tools = await cachedTools(fetchImpl, user.userId, target, endpoints);
    for (const tool of tools) {
      const exposed = namespaceTool(target.name, tool.name);
      if (!exposed || seen.has(exposed)) continue;
      seen.add(exposed);
      const description = (tool.description ?? `Tool ${tool.name} on ${target.name}.`).slice(0, 2000);
      server.registerTool(exposed, {
        title: `${target.name}: ${tool.title || tool.name}`.slice(0, 120),
        description: `${description} Recorded by Life Diff.`,
        inputSchema: schemaFor(tool.inputSchema),
      }, async (args, ctx: ServerContext) => {
        const reply = await forwardToolCall(coreDeps(env, user), fetchImpl, target, tool.name, args, endpoints, clientName(server, ctx));
        return {
          content: reply.content,
          ...(reply.isError !== undefined ? { isError: reply.isError } : {}),
          ...(reply.structuredContent ? { structuredContent: reply.structuredContent } : {}),
          ...(reply._meta ? { _meta: reply._meta } : {}),
        };
      });
    }
  }));
}

async function cachedTools(fetchImpl: typeof fetch, userId: string, target: UpstreamTarget, endpoints: ReadonlySet<string>): Promise<UpstreamToolInfo[]> {
  const key = catalogKey(userId, target);
  const hit = catalogEntry(userId, target);
  if (hit) return hit.tools;
  try {
    const tools = await listUpstreamTools(fetchImpl, target, endpoints);
    catalog.set(key, { at: Date.now(), tools, ttl: CACHE_MS });
    return tools;
  } catch (error) {
    catalog.set(key, { at: Date.now(), tools: [], ttl: ERROR_CACHE_MS, redirected: error instanceof UpstreamRedirectError });
    return [];
  }
}

function schemaFor(raw: Record<string, unknown> | undefined): typeof looseArgs {
  if (!raw) return looseArgs;
  try {
    return fromJsonSchema(raw) as typeof looseArgs;
  } catch {
    return looseArgs;
  }
}
