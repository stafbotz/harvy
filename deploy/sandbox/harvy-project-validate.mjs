#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const mode = process.argv[2];
if (!new Set(["test", "lint", "typecheck", "build"]).has(mode)) {
  console.error("HARVY_VALIDATOR_INVALID_MODE");
  process.exit(64);
}

const packageJson = jsonFile("package.json");
if (packageJson) {
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const script = mode === "typecheck"
    ? firstScript(scripts, ["typecheck", "type-check", "check:types"])
    : firstScript(scripts, [mode]);
  if (script) run(packageManager(), script);
  if (mode === "test") {
    console.error("HARVY_VALIDATOR_REQUIRED_TEST_MISSING");
    process.exit(78);
  }
  notApplicable();
}

if (existsSync("Cargo.toml")) {
  if (mode === "test") run("cargo", "test");
  if (mode === "typecheck" || mode === "lint") run("cargo", "check");
  if (mode === "build") run("cargo", "build");
}

if (existsSync("pyproject.toml") || existsSync("pytest.ini") ||
    existsSync("setup.cfg") || existsSync("requirements.txt")) {
  if (mode === "test") run("python3", "-m", "pytest");
  if (mode === "typecheck" && pythonModuleConfigured("mypy")) {
    run("python3", "-m", "mypy", ".");
  }
  if (mode === "lint" && pythonModuleConfigured("ruff")) {
    run("python3", "-m", "ruff", "check", ".");
  }
  if (mode === "build" && existsSync("pyproject.toml")) {
    // A compile pass remains offline and catches syntax/import bytecode errors.
    run("python3", "-m", "compileall", "-q", ".");
  }
  notApplicable();
}

if (existsSync("gradlew") || existsSync("build.gradle") ||
    existsSync("build.gradle.kts")) {
  const gradle = existsSync("gradlew") ? "./gradlew" : "gradle";
  if (mode === "test") run(gradle, "test", "--no-daemon");
  if (mode === "lint") notApplicable();
  if (mode === "typecheck" || mode === "build") {
    run(gradle, "classes", "--no-daemon");
  }
}

if (mode === "test") {
  console.error("HARVY_VALIDATOR_REQUIRED_TEST_MISSING");
  process.exit(78);
}
notApplicable();

function jsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    console.error("HARVY_VALIDATOR_MANIFEST_INVALID");
    process.exit(65);
  }
}

function firstScript(scripts, names) {
  for (const name of names) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) return name;
  }
  return null;
}

function packageManager() {
  if (existsSync("pnpm-lock.yaml")) return "pnpm";
  if (existsSync("yarn.lock")) return "yarn";
  return "npm";
}

function pythonModuleConfigured(name) {
  const text = ["pyproject.toml", "requirements.txt", "setup.cfg"]
    .filter(existsSync)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
    .toLocaleLowerCase("en-US");
  return text.includes(name);
}

function run(command, ...args) {
  const managerArgs = command === "npm"
    ? ["run", args[0], "--if-present"]
    : command === "pnpm" || command === "yarn"
      ? ["run", args[0]]
      : args;
  const result = spawnSync(command, managerArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    console.error("HARVY_VALIDATOR_EXEC_FAILED");
    process.exit(70);
  }
  process.exit(Number.isInteger(result.status) ? result.status : 70);
}

function notApplicable() {
  console.log(`HARVY_VALIDATOR_NOT_APPLICABLE:${mode}`);
  process.exit(0);
}
