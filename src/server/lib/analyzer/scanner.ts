/**
 * File collection + tech stack detection (pure rules).
 *
 * - Recursively collects source files, excluding build/dependency directories
 * - Tech stack: pom.xml / build.gradle -> java-spring; go.mod -> go;
 *   package.json + .vue files -> vue; package.json depending on lit /
 *   @yukino.js/lit-jsx -> lit
 */
import fs from "node:fs";
import path from "node:path";

const EXCLUDE_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  ".venv",
  "__pycache__",
  ".idea",
  "outputs",
  ".next",
  ".output",
  "coverage",
]);

export interface ScanResult {
  root: string;
  files: string[];
  backend: string | null;
  frontend: string | null;
  hasPom: boolean;
  hasGradle: boolean;
  hasGoMod: boolean;
  hasPackageJson: boolean;
  hasVue: boolean;
  hasLitJsx: boolean;
}

export function scan(root: string): ScanResult {
  const result: ScanResult = {
    root: path.resolve(root),
    files: [],
    backend: null,
    frontend: null,
    hasPom: false,
    hasGradle: false,
    hasGoMod: false,
    hasPackageJson: false,
    hasVue: false,
    hasLitJsx: false,
  };
  if (!fs.existsSync(result.root) || !fs.statSync(result.root).isDirectory()) {
    return result;
  }

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.name === "pom.xml") result.hasPom = true;
      else if (entry.name === "go.mod") result.hasGoMod = true;
      else if (
        entry.name === "build.gradle" ||
        entry.name === "build.gradle.kts"
      )
        result.hasGradle = true;
      else if (entry.name === "package.json") {
        result.hasPackageJson = true;
        if (dependsOnLit(abs)) result.hasLitJsx = true;
      } else if (entry.name.endsWith(".vue")) result.hasVue = true;
      result.files.push(path.relative(result.root, abs));
    }
  };
  walk(result.root);

  if (result.hasPom || result.hasGradle) result.backend = "java-spring";
  else if (result.hasGoMod) result.backend = "go";
  if (result.hasPackageJson && result.hasVue) result.frontend = "vue";
  else if (result.hasPackageJson && result.hasLitJsx) result.frontend = "lit";
  return result;
}

/** True when a package.json depends on lit or @yukino.js/lit-jsx. */
function dependsOnLit(packageJsonFile: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonFile, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };
    return Object.keys(deps).some(
      (name) => name === "lit" || name === "@yukino.js/lit-jsx",
    );
  } catch {
    return false;
  }
}

export function techStackOf(result: ScanResult): Record<string, string | null> {
  return { backend: result.backend, frontend: result.frontend };
}

/** Absolute paths of collected files filtered by extension (lowercase, with dot). */
export function listByExt(result: ScanResult, exts: Set<string>): string[] {
  return result.files
    .filter((file) => exts.has(path.extname(file).toLowerCase()))
    .map((file) => path.join(result.root, file));
}

export function readFileSafe(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
