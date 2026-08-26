/**
 * The flat-parameter rule, enforced rather than described.
 *
 * A self-hosted GLM implementer failed 23 consecutive `agent_handoff` calls
 * against a schema whose only sin was one level of nesting: `{ handoff: {...} }`.
 * It composed correct content every time, could not close two levels of braces,
 * diagnosed the problem correctly in its own transcript, and began stripping
 * quotes out of its own evidence strings trying to satisfy the parser. Flattening
 * took the retry count to zero.
 *
 * These tools are aimed at exactly that class of model, so the rule is a
 * property of the toolkit and not a note in a document someone may not read.
 */
import { assert, describe, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import {
  AgentHandoffTool,
  AgentInboxTool,
  AgentMessageTool,
  AgentSpawnTool,
  OrchestrationToolkit,
} from "./tools.ts";

const tools = [AgentSpawnTool, AgentHandoffTool, AgentMessageTool, AgentInboxTool];

interface JsonSchema {
  readonly type?: string | ReadonlyArray<string>;
  readonly properties?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
  readonly anyOf?: ReadonlyArray<JsonSchema>;
  readonly oneOf?: ReadonlyArray<JsonSchema>;
  readonly allOf?: ReadonlyArray<JsonSchema>;
  readonly $ref?: string;
}

const hasType = (schema: JsonSchema, expected: string): boolean =>
  schema.type === expected || (Array.isArray(schema.type) && schema.type.includes(expected));

const branches = (schema: JsonSchema): ReadonlyArray<JsonSchema> => [
  ...(schema.anyOf ?? []),
  ...(schema.oneOf ?? []),
  ...(schema.allOf ?? []),
];

/**
 * Names every property whose value a model would have to emit as a nested
 * object. Arrays of scalars are fine — the live failure was brace depth, and a
 * string array costs a model brackets, not another `}` to track.
 */
const nestedObjectProperties = (schema: JsonSchema): ReadonlyArray<string> => {
  const offenders: Array<string> = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const candidates = [
      property,
      ...branches(property),
      ...(property.items ? [property.items] : []),
    ];
    for (const candidate of candidates) {
      const nestsObject =
        hasType(candidate, "object") &&
        (candidate.properties !== undefined || candidate.$ref !== undefined);
      if (nestsObject) offenders.push(name);
    }
  }
  return offenders;
};

describe("toolkit parameter shapes stay flat", () => {
  for (const tool of tools) {
    it(`${tool.name} takes no nested object parameters`, () => {
      const schema = Tool.getJsonSchema(tool) as JsonSchema;
      const offenders = nestedObjectProperties(schema);
      assert.deepStrictEqual(
        offenders,
        [],
        `${tool.name} nests an object under ${offenders.join(", ")}. A self-hosted implementer cannot reliably emit that; hoist the fields to the top level.`,
      );
    });
  }

  it("covers every tool the toolkit registers", () => {
    // Keeps the rule from silently skipping a tool added later.
    const registered = Object.keys(OrchestrationToolkit.tools).sort();
    assert.deepStrictEqual(
      tools.map((tool) => tool.name).sort(),
      registered,
      "a tool was added to the toolkit without being covered by the flat-parameter rule",
    );
  });
});
