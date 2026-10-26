/**
 * Go state machine extraction (pure rules + source evidence).
 *
 * Mirrors state-machine.ts (Java) for Go services:
 * 1. Find the status enum -> states (const values + label map)
 * 2. Find `x.Status = Ident` write sites
 * 3. Walk up to the enclosing func; infer the trigger from the func name
 * 4. Nearest `if` guard above the write site containing status constants:
 *    - `!=` guard -> from = the named states
 *    - `==` guard -> from = all states - named
 *    - no guard   -> from = all states - target
 * 5. verified=true (the write site itself is the evidence)
 */
import path from "node:path";

import { collectGoEnums } from "./go";
import { readFileSafe } from "./scanner";
import { triggerFor } from "./state-machine";

import type {
  BackendResult,
  StateMachineSpec,
  StateMachineState,
  StateMachineTransition,
} from "#/lib/types";

/** Assignment only: `=(?!=)` skips `==`; `!=` never matches (leading `!`). */
const STATUS_WRITE_RE = /\.(\w*[Ss]tatus)\s*=(?!=)\s*([A-Za-z_]\w*)/;
const FUNC_RE = /^func\s+(?:\(\s*\w+\s+\*?[\w.[\]]+\s*\)\s*)?(\w+)\s*\(/;
const IF_RE = /^\s*(?:}\s*else\s+)?if\s+(.+?)\s*\{\s*(?:\/\/.*)?$/;
const ERROR_EMIT_RE = /errors\.New\s*\(|fmt\.Errorf\s*\(|\.Throw\s*\(/;
const IDENT_RE = /\b([A-Z]\w*)\b/g;
const STRING_LITERAL_RE = /"([A-Z][A-Z0-9_]*)"/g;

function findStatusEnum(
  backend: BackendResult,
): { name: string; states: StateMachineState[] } | null {
  for (const en of backend.enums) {
    const lower = en.name.toLowerCase();
    const isStatus = lower.includes("status") || lower.includes("state");
    if (isStatus && en.values.length > 0) {
      return {
        name: en.name,
        states: en.values.map((v) => ({ name: v.name, label: v.label })),
      };
    }
  }
  for (const en of backend.enums) {
    if (en.values.length > 0) {
      return {
        name: en.name,
        states: en.values.map((v) => ({ name: v.name, label: v.label })),
      };
    }
  }
  return null;
}

/** Status names referenced by a guard: Go const idents + string literals. */
function guardStates(
  guard: string,
  identToValue: Map<string, string>,
  allStates: string[],
): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const identRe = new RegExp(IDENT_RE.source, "g");
  while ((m = identRe.exec(guard)) !== null) {
    const value = identToValue.get(m[1]);
    if (value && allStates.includes(value)) out.add(value);
  }
  const litRe = new RegExp(STRING_LITERAL_RE.source, "g");
  while ((m = litRe.exec(guard)) !== null) {
    if (allStates.includes(m[1])) out.add(m[1]);
  }
  return out;
}

export function extractGoStateMachines(
  backend: BackendResult,
  goFiles: string[],
  root: string,
): StateMachineSpec[] {
  const found = findStatusEnum(backend);
  if (!found) return [];
  const allStates = found.states.map((s) => s.name);
  const { identToValue } = collectGoEnums(goFiles);
  const result: StateMachineSpec = {
    name: found.name,
    states: found.states,
    transitions: [],
    confidence: 1,
  };

  let trCounter = 0;
  for (const file of goFiles) {
    const rel = path.relative(root, file);
    const lines = readFileSafe(file).split("\n");

    for (let i = 0; i < lines.length; i++) {
      const sm = STATUS_WRITE_RE.exec(lines[i]);
      if (!sm) continue;
      const target = identToValue.get(sm[2]);
      if (!target || !allStates.includes(target)) continue;
      // Writing the initial state is object initialization (e.g. Create()
      // assigning StatusCreated), not a transition; skip it.
      if (allStates.length > 0 && target === allStates[0]) continue;

      // Walk up to the enclosing func (method boundary).
      let funcName: string | null = null;
      let funcStart: number | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const fm = FUNC_RE.exec(lines[j]);
        if (fm) {
          funcName = fm[1]!;
          funcStart = j;
          break;
        }
      }

      // Nearest status guard above, inside the same func, with an error
      // emission between guard and write site.
      let guardText: string | null = null;
      let guardStatesSet = new Set<string>();
      if (funcName) {
        for (let j = i - 1; j >= (funcStart ?? 0); j--) {
          const im = IF_RE.exec(lines[j]);
          if (!im) continue;
          const states = guardStates(im[1], identToValue, allStates);
          if (states.size === 0) continue;
          const seg = lines.slice(j, i).join("\n");
          if (ERROR_EMIT_RE.test(seg)) {
            guardText = im[1].trim();
            guardStatesSet = states;
            break;
          }
        }
      }

      let fromStates: string[];
      if (guardText) {
        if (guardText.includes("!=")) {
          fromStates = [...guardStatesSet].sort();
        } else {
          fromStates = allStates.filter((s) => !guardStatesSet.has(s)).sort();
        }
      } else {
        fromStates = allStates.filter((s) => s !== target).sort();
      }
      fromStates = fromStates.filter((s) => s !== target);

      const evidence = [`${rel}#${i + 1}`];
      for (const ep of backend.endpoints) {
        if (ep.methodName === funcName) {
          evidence.push(`${ep.file}#${ep.line}`);
          break;
        }
      }

      for (const from of fromStates) {
        trCounter += 1;
        const transition: StateMachineTransition = {
          id: `tr-${trCounter}`,
          from,
          to: target,
          trigger: triggerFor(funcName || ""),
          verified: true,
          evidence,
          guard: guardText || "",
        };
        result.transitions.push(transition);
      }
    }
  }

  if (result.transitions.length === 0) return [];
  return [result];
}
