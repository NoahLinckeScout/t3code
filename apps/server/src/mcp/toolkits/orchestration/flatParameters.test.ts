/**
 * The top-level wrapper rule, enforced rather than described.
 *
 * A tool's `parameters` must carry its required fields at the **top level**. One
 * wrapper object around them is the thing self-hosted implementers cannot
 * reliably emit. Nesting *below* the top level is fine.
 *
 * Measured on the two self-hosted models this harness targets, same prompt, same
 * tool, five runs each, the only variable being one level of top-level wrapping:
 *
 * | parameters shape                                    | GLM 5.2 | GLM 5.3-Flash |
 * | --------------------------------------------------- | ------- | ------------- |
 * | required fields at top level (incl. array of objects) | —      | 5/5 valid     |
 * | identical fields wrapped in one top-level object      | 0/23   | 3/5 valid     |
 *
 * The 5.2 figure is from production: a child failed 23 consecutive
 * `agent_handoff` calls against `{ handoff: {...} }`, every one
 * `JSON Parse error: Expected '}'`. Upgrading the model narrows the failure but
 * does not remove it, which is why this is a rule and not a workaround.
 *
 * Note what this rule does *not* forbid. An array of objects with their own
 * required fields passed 5/5, so destructuring such an array into parallel
 * scalar arrays would make tools worse to use for no measured benefit.
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
 * Names each top-level parameter that is itself an object.
 *
 * Only the top level is inspected. `property.items` is deliberately not
 * followed: an array of objects is a measured-good shape, and flagging it would
 * enforce a stricter rule than the evidence supports.
 */
const topLevelObjectParameters = (schema: JsonSchema): ReadonlyArray<string> => {
  const offenders: Array<string> = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const candidates = [property, ...branches(property)];
    const wrapsObject = candidates.some(
      (candidate) =>
        hasType(candidate, "object") &&
        (candidate.properties !== undefined || candidate.$ref !== undefined),
    );
    if (wrapsObject) offenders.push(name);
  }
  return offenders;
};

describe("toolkit parameters carry their required fields at the top level", () => {
  for (const tool of tools) {
    it(`${tool.name} has no top-level wrapper object`, () => {
      const schema = Tool.getJsonSchema(tool) as JsonSchema;
      const offenders = topLevelObjectParameters(schema);
      assert.deepStrictEqual(
        offenders,
        [],
        `${tool.name} wraps its fields in a top-level object (${offenders.join(", ")}). Self-hosted implementers emit empty arguments for that shape roughly 40% of the time on GLM 5.3-Flash, and never got it right on 5.2. Hoist the fields to the top level.`,
      );
    });
  }

  it("permits an array of objects, which is a measured-good shape", () => {
    // Guards against re-tightening this rule into "no nested objects anywhere",
    // which would push future tools into parallel scalar arrays for no benefit.
    const arrayOfObjects: JsonSchema = {
      type: "object",
      properties: {
        validation: {
          type: "array",
          items: {
            type: "object",
            properties: { command: { type: "string" }, result: { type: "string" } },
          },
        },
      },
    };
    assert.deepStrictEqual(topLevelObjectParameters(arrayOfObjects), []);
  });

  it("catches a top-level wrapper", () => {
    const wrapped: JsonSchema = {
      type: "object",
      properties: { handoff: { type: "object", properties: { status: { type: "string" } } } },
    };
    assert.deepStrictEqual(topLevelObjectParameters(wrapped), ["handoff"]);
  });

  it("covers every tool the toolkit registers", () => {
    // Keeps the rule from silently skipping a tool added later.
    const registered = Object.keys(OrchestrationToolkit.tools).sort();
    assert.deepStrictEqual(
      tools.map((tool) => tool.name).sort(),
      registered,
      "a tool was added to the toolkit without being covered by the top-level wrapper rule",
    );
  });
});
