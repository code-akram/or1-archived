import { Buffer } from "node:buffer";
import { InputError, type Role } from "@or1/core";
import type { PortableStore } from "@or1/store/portable";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/** Per-call context supplied by the adapter (pi agent, MCP, HTTP or CLI). The role comes from credentials. */
export type ToolContext = {
  readonly role: Role;
  readonly store?: PortableStore;
  readonly namespace?: string;
  readonly scope?: { readonly projectId: string; readonly ref: string };
  readonly runId?: string;
  /** Trusted restrictive capability: only review_option for this whole project, never acceptance. */
  readonly reviewProjectId?: string;
};

export type ToolResult = {
  /** Model-facing summary. */
  readonly text: string;
  /** Structured result for programmatic callers and the UI. */
  readonly data: unknown;
};

/**
 * One tool definition. The TypeBox schema is plain JSON Schema, so the same definition generates
 * pi AgentTools, MCP tools (via fromJsonSchema), HTTP handlers and CLI commands.
 */
export type ToolDefinition<P extends TSchema = TSchema> = {
  readonly name: string;
  readonly description: string;
  readonly parameters: P;
  /** Mutations use store.execute; geometry evaluation uses core.applyChanges. */
  readonly mutates: boolean;
  execute(params: Static<P>, ctx: ToolContext): Promise<ToolResult>;
};

/** Unscoped owner credentials only; never a run binding or a project review capability. */
const OWNER_TOOLS = new Set([
  "review_option",
  "accept_option",
  "project_overview",
  "list_projects",
]);

export function defineTool<P extends TSchema>(tool: ToolDefinition<P>): ToolDefinition<P> {
  return {
    ...tool,
    async execute(params, ctx) {
      try {
        validateJson(params);
        if (!Value.Check(tool.parameters, params))
          return result({ ok: false, code: "invalid_input", message: "Invalid tool parameters" });
        if (
          !ctx ||
          !["owner", "agent", "external"].includes(ctx.role) ||
          typeof ctx.namespace !== "string" ||
          !ctx.namespace.length ||
          ctx.namespace.length > 256 ||
          [...ctx.namespace].some((character) => character.charCodeAt(0) < 32)
        )
          return result({ ok: false, code: "unauthorized" });
        const input = params as { projectId?: string; ref?: string; body?: { sourceRef?: string } };
        if (ctx.reviewProjectId !== undefined) {
          if (
            typeof ctx.reviewProjectId !== "string" ||
            !ctx.reviewProjectId.length ||
            ctx.reviewProjectId.length > 128 ||
            [...ctx.reviewProjectId].some((character) => character.charCodeAt(0) < 32)
          )
            return result({ ok: false, code: "unauthorized" });
          if (
            tool.name !== "review_option" ||
            input.projectId !== ctx.reviewProjectId ||
            ctx.role === "agent" ||
            ctx.scope !== undefined
          )
            return result({ ok: false, code: "forbidden" });
          if (ctx.runId !== undefined) return result({ ok: false, code: "invalid_run_binding" });
        } else if (OWNER_TOOLS.has(tool.name)) {
          if (ctx.role !== "owner" || ctx.scope !== undefined)
            return result({ ok: false, code: "forbidden" });
          if (ctx.runId !== undefined) return result({ ok: false, code: "invalid_run_binding" });
        }
        if (
          ctx.scope &&
          (input.projectId !== ctx.scope.projectId ||
            (input.ref ?? "main") !== ctx.scope.ref ||
            (input.body?.sourceRef !== undefined && input.body.sourceRef !== ctx.scope.ref))
        )
          return result({ ok: false, code: "forbidden", message: "Outside credential scope" });
        if (!ctx.store) return result({ ok: false, code: "store_unavailable" });
        return await tool.execute(params, ctx);
      } catch (error) {
        if (error instanceof InputError)
          return result({ ok: false, code: error.code, message: error.message });
        throw error;
      }
    },
  };
}

/** Budget checked incrementally before stringifying or traversing nested untrusted input. */
export const MAX_TOOL_INPUT_BYTES = 1_048_576;
export function validateJson(value: unknown): void {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const add = (size: number) => {
    bytes += size;
    if (bytes > MAX_TOOL_INPUT_BYTES)
      throw new InputError("limit_exceeded", "Tool input byte limit");
  };
  const string = (s: string) => {
    // UTF-16 length is a lower bound on JSON UTF-8 bytes: reject before allocating an encoding.
    add(s.length);
    add(Buffer.byteLength(JSON.stringify(s)) - s.length);
  };
  const visit = (v: unknown, depth: number): void => {
    if (depth > 64 || ++nodes > 100_000)
      throw new InputError("limit_exceeded", "Tool input depth/node limit");
    if (v === null || typeof v === "boolean") {
      add(v === null ? 4 : v ? 4 : 5);
      return;
    }
    if (typeof v === "string") {
      string(v);
      return;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      add(String(v).length);
      return;
    }
    if (typeof v !== "object" || v === null)
      throw new InputError("invalid_input", "Tool input must be finite JSON");
    if (ancestors.has(v)) throw new InputError("invalid_input", "Cyclic tool input");
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
      throw new InputError("invalid_input", "Tool input must contain plain JSON objects");
    ancestors.add(v);
    add(2);
    if (Array.isArray(v)) {
      if (v.length > 100_000) throw new InputError("limit_exceeded", "Tool input array limit");
      for (let i = 0; i < v.length; i++) {
        if (i) add(1);
        visit(v[i], depth + 1);
      }
    } else {
      let i = 0;
      for (const key in v) {
        if (!Object.hasOwn(v, key)) continue;
        if (i++) add(1);
        string(key);
        add(1);
        visit((v as Record<string, unknown>)[key], depth + 1);
      }
    }
    ancestors.delete(v);
  };
  visit(value, 0);
}

export function result<T extends { ok: boolean; code?: string; message?: string }>(
  data: T,
): ToolResult {
  return {
    text: data.ok ? JSON.stringify(data) : `${data.code}: ${data.message ?? "Rejected"}`,
    data,
  };
}
