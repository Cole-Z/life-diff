import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";

export function jsonSchema(schema: Record<string, unknown> | undefined): StandardSchemaWithJSON {
  const rooted: Record<string, unknown> = schema && (schema.type === "object" || schema.properties)
    ? { type: "object", ...schema }
    : { type: "object", additionalProperties: true };
  return {
    "~standard": {
      version: 1,
      vendor: "lifediff",
      jsonSchema: {
        input: () => rooted,
        output: () => rooted,
      },
      validate: (value) => ({ value }),
    },
  };
}
