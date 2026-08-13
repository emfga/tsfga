/**
 * Which patterns does OpenFGA store, and which does cel-js
 * compile?
 *
 * Produces the three groups of `../regex/re2-vs-celjs.md`. Run it
 * from the conformance workspace, where the OpenFGA SDK and the
 * container helpers resolve:
 *
 *   cp docs/cel-js/probes/re2-acceptance.ts tests/conformance/
 *   cd tests/conformance && bun re2-acceptance.ts
 *
 * OpenFGA compiles every condition while it validates the model
 * write, so an RE2 syntax error surfaces as a refused model rather
 * than as a failed check. That is why the probe writes models
 * rather than running checks.
 */
import { TypeName, type WriteAuthorizationModelRequest } from "@openfga/sdk";
import { fgaCreateStore, fgaWriteModelOutcome } from "./helpers/openfga.ts";

function modelWith(expression: string): WriteAuthorizationModelRequest {
  return {
    schema_version: "1.1",
    type_definitions: [
      { type: "user", relations: {}, metadata: { relations: {} } },
      {
        type: "doc",
        relations: { viewer: { this: {} } },
        metadata: {
          relations: {
            viewer: {
              directly_related_user_types: [
                { type: "user", condition: "gate" },
              ],
            },
          },
        },
      },
    ],
    conditions: {
      gate: {
        name: "gate",
        expression,
        parameters: { s: { type_name: TypeName.String } },
      },
    },
  };
}

const PATTERNS = [
  // RE2 rejects, JavaScript accepts
  "(?=a)",
  "(?!a)",
  "(?<=a)",
  "(?<!a)",
  "(a)\\1",
  "(?<n>a)\\k<n>",
  "\\y",
  "\\Z",
  "\\cA",
  "[\\b]",
  "[^]",
  "[a-\\w]",
  "^[^]*$",
  "a{1001}",
  // both accept, readings differ
  "\\A",
  "\\Qa.b\\E",
  "\\s",
  "[[:alnum:]]",
  "[[:alpha:]]",
  "\\p{L}",
  "\\pL",
  // RE2 accepts, JavaScript rejects
  "(?i)abc",
  "(?P<n>a)",
  // a control that both take
  "^ward-[0-9]+$",
];

const storeId = await fgaCreateStore("probe-re2-acceptance");

for (const pattern of PATTERNS) {
  const expression = `s.matches(${JSON.stringify(pattern)})`;
  const written = await fgaWriteModelOutcome(storeId, modelWith(expression));
  let celjs = "accepted";
  try {
    new RegExp(pattern);
  } catch (error) {
    celjs = `refused (${(error as Error).message})`;
  }
  console.log(
    JSON.stringify({
      pattern,
      openfga: written === "accepted" ? "accepted" : "refused",
      celjs,
    }),
  );
}
