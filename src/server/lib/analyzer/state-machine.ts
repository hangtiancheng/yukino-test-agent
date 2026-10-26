/**
 * State machine extraction (pure rules + source evidence).
 *
 * Flow:
 * 1. Find the status enum -> states
 * 2. Find setStatus(X) / setXxxStatus(X) write sites
 * 3. Walk up to the method boundary; infer the trigger from the method name
 * 4. Walk up inside the method for a status guard (an `if` containing status
 *    literals) and derive `from`:
 *    - negated guard if(!X) throw -> from = {X}
 *    - positive guard if(X) throw -> from = all states - X
 *    - no guard                   -> from = all states - target
 * 5. verified=true only when the status write line (setStatus) was found
 * 6. BFS shortest advance paths (used for pre-steps of state cases)
 */
import path from "node:path";

import { readFileSafe } from "./scanner";

import type {
  BackendResult,
  StateMachineSpec,
  StateMachineState,
  StateMachineTransition,
} from "#/lib/types";

const SET_STATUS_RE = /\.?\s*set\w*Status\s*\(\s*([^)]*?)\s*\)/;
const METHOD_SIG_RE =
  /\b(public|private|protected)\s+[A-Za-z_<>,.[\]\s]+\s+(\w+)\s*\(/;
const IF_RE = /\bif\s*\(([^{}]*)\)/;
const THROW_RE = /\bthrow\b/;
const STATUS_LITERAL_RE =
  /"([A-Z][A-Z0-9_]*)"|\b(?:[A-Z]\w+)?(?:Status|State)\s*\.\s*([A-Z][A-Z0-9_]*)/;

/** Method name -> UI button text on the system under test. */
const TRIGGER_MAP: Record<string, string> = {
  pay: "Pay",
  ship: "Ship",
  deliver: "Ship",
  complete: "Complete",
  cancel: "Cancel",
  create: "Create",
  submit: "Submit",
  update: "Update",
  delete: "Delete",
  remove: "Delete",
  approve: "Approve",
  reject: "Reject",
  refund: "Refund",
  receive: "Confirm Receipt",
  confirm: "Confirm",
  start: "Start",
  close: "Close",
  finish: "Complete",
  send: "Send",
};

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
  // Fallback: first enum with values
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

function extractStatusLiterals(guard: string): Set<string> {
  const out = new Set<string>();
  STATUS_LITERAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(STATUS_LITERAL_RE.source, "g");
  while ((m = re.exec(guard)) !== null) {
    const value = m[1] || m[2];
    if (value) out.add(value);
  }
  return out;
}

function isNegated(guard: string): boolean {
  return /!\s*(?:[\w."'()]+\.equals|"[A-Z_]+")/.test(guard);
}

function targetState(args: string): string | null {
  const m = /(?:Status|State)\s*\.\s*([A-Z][A-Z0-9_]*)/.exec(args);
  if (m) return m[1];
  const n = /\b([A-Z][A-Z0-9_]*)\b/.exec(args);
  return n ? n[1] : null;
}

export function triggerFor(methodName: string): string {
  return TRIGGER_MAP[methodName.toLowerCase()] ?? methodName;
}

export function extractStateMachines(
  backend: BackendResult,
  javaFiles: string[],
  root: string,
): StateMachineSpec[] {
  const found = findStatusEnum(backend);
  if (!found) return [];
  const allStates = found.states.map((s) => s.name);
  const result: StateMachineSpec = {
    name: found.name,
    states: found.states,
    transitions: [],
    confidence: 1,
  };

  let trCounter = 0;
  for (const file of javaFiles) {
    const rel = path.relative(root, file);
    const lines = readFileSafe(file)
      .split("\n")
      .map((ln) => ln.replace(/\n$/, ""));

    for (let i = 0; i < lines.length; i++) {
      const sm = SET_STATUS_RE.exec(lines[i]);
      if (!sm) continue;
      const target = targetState(sm[1]);
      if (!target || !allStates.includes(target)) continue;
      // Writing the initial state is object initialization (e.g. create()
      // calling setStatus(CREATED)), not a transition; skip it.
      if (allStates.length > 0 && target === allStates[0]) continue;

      // Walk up to the method signature (method boundary)
      let methodName: string | null = null;
      let methodStart: number | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const mm = METHOD_SIG_RE.exec(lines[j]);
        if (mm) {
          methodName = mm[2]!;
          methodStart = j;
          break;
        }
      }

      // Nearest status-literal guard above, inside the same method,
      // followed by a throw between guard and write site.
      let guardText: string | null = null;
      if (methodName) {
        for (let j = i - 1; j >= (methodStart ?? 0); j--) {
          const im = IF_RE.exec(lines[j]);
          if (im) {
            const cond = im[1];
            if (extractStatusLiterals(cond).size > 0) {
              const seg = lines.slice(j, i).join("\n");
              if (THROW_RE.test(seg)) {
                guardText = cond.trim();
                break;
              }
            }
          }
        }
      }

      let fromStates: string[];
      if (guardText) {
        const literals = extractStatusLiterals(guardText);
        if (isNegated(guardText)) {
          fromStates = [...literals].sort();
        } else {
          fromStates = allStates.filter((s) => !literals.has(s)).sort();
        }
      } else {
        fromStates = allStates.filter((s) => s !== target).sort();
      }
      fromStates = fromStates.filter((s) => s !== target);

      trCounter += 1;
      const evidence = [`${rel}#${i + 1}`];
      for (const ep of backend.endpoints) {
        if (ep.methodName === methodName) {
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
          trigger: triggerFor(methodName || ""),
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

/**
 * BFS shortest advance paths from the initial state to every state
 * (inclusive). Returns { state: [initial, ..., state] }.
 */
export function bfsPaths(
  states: StateMachineState[],
  transitions: Pick<StateMachineTransition, "from" | "to">[],
  initialState: string,
): Record<string, string[]> {
  const names = states.map((s) => s.name);
  const adj = new Map<string, Set<string>>();
  for (const name of names) adj.set(name, new Set());
  for (const t of transitions) {
    if (!adj.has(t.from)) adj.set(t.from, new Set());
    adj.get(t.from)!.add(t.to);
  }

  const paths: Record<string, string[]> = { [initialState]: [initialState] };
  const queue: string[] = [initialState];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!(next in paths)) {
        paths[next] = [...paths[cur], next];
        queue.push(next);
      }
    }
  }
  return paths;
}
