import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Runner común para jobs locales que usan Claude Code en modo no interactivo (`claude -p`).
 * Pensado para el Mac worker: usa la sesión de Claude del usuario (plan), no una API key.
 *
 * Env:
 *   CLAUDE_BIN      — ruta al binario (default: ~/.local/bin/claude si existe, si no `claude` del PATH)
 *   CLAUDE_MODEL    — modelo opcional (`--model`)
 *   CLAUDE_TIMEOUT_MS — timeout por llamada (default 15 min)
 */

export class ClaudeCliError extends Error {
  /** @param {string} message @param {{ kind?: "auth"|"timeout"|"exit"|"parse"|"result", stderr?: string, exitCode?: number|null }} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = "ClaudeCliError";
    this.kind = info.kind || "exit";
    this.stderr = info.stderr || "";
    this.exitCode = info.exitCode ?? null;
  }
}

export function resolveClaudeBin(env = process.env) {
  if (env.CLAUDE_BIN?.trim()) return env.CLAUDE_BIN.trim();
  const local = path.join(os.homedir(), ".local", "bin", "claude");
  return fs.existsSync(local) ? local : "claude";
}

const AUTH_HINTS = /(not logged in|please run \/login|invalid api key|authentication|unauthorized|oauth token|credentials)/i;

/** Detecta si un texto de error huele a sesión caducada / no autenticada. */
export function looksLikeAuthError(text) {
  return AUTH_HINTS.test(String(text || ""));
}

/**
 * Construye los argumentos de `claude -p`.
 * @param {{ prompt: string, allowedTools?: string[], disallowedTools?: string[], model?: string, maxTurns?: number }} opts
 */
export function buildClaudeArgs({ prompt, allowedTools = [], disallowedTools = [], model, maxTurns } = {}) {
  const args = ["-p", prompt, "--output-format", "json"];
  if (allowedTools.length) args.push("--allowedTools", allowedTools.join(","));
  if (disallowedTools.length) args.push("--disallowedTools", disallowedTools.join(","));
  if (model) args.push("--model", model);
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  return args;
}

/**
 * Interpreta la salida JSON de `claude -p --output-format json`.
 * @returns {{ text: string, costUsd: number|null, usage: object|null, sessionId: string|null, raw: object }}
 */
export function parseClaudeJson(stdout) {
  let obj;
  try {
    obj = JSON.parse(String(stdout).trim());
  } catch {
    // Algunas versiones pueden emitir líneas previas; nos quedamos con el último objeto JSON.
    const lines = String(stdout).trim().split("\n").filter(Boolean);
    const last = lines[lines.length - 1];
    try {
      obj = JSON.parse(last);
    } catch {
      throw new ClaudeCliError("Salida de Claude no es JSON", { kind: "parse" });
    }
  }
  if (Array.isArray(obj)) obj = obj.filter((e) => e?.type === "result").pop() || obj[obj.length - 1];
  const text = typeof obj?.result === "string" ? obj.result : "";
  if (obj?.is_error || obj?.subtype?.startsWith?.("error")) {
    const msg = text || obj?.subtype || "error";
    throw new ClaudeCliError(`Claude devolvió error: ${msg.slice(0, 300)}`, {
      kind: looksLikeAuthError(msg) ? "auth" : "result"
    });
  }
  return {
    text,
    costUsd: typeof obj?.total_cost_usd === "number" ? obj.total_cost_usd : null,
    usage: obj?.usage || null,
    sessionId: obj?.session_id || null,
    raw: obj
  };
}

/**
 * Ejecuta `claude -p`. El contexto grande va por stdin (evita el límite de argv).
 * @param {{ prompt: string, stdin?: string, cwd?: string, allowedTools?: string[], disallowedTools?: string[], model?: string, maxTurns?: number, timeoutMs?: number, env?: NodeJS.ProcessEnv }} opts
 */
export function runClaude(opts) {
  const env = opts.env || process.env;
  const bin = resolveClaudeBin(env);
  const args = buildClaudeArgs({ ...opts, model: opts.model || env.CLAUDE_MODEL?.trim() || undefined });
  const timeoutMs = opts.timeoutMs ?? Number(env.CLAUDE_TIMEOUT_MS || 15 * 60_000);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd || process.cwd(),
      env: { ...env, PATH: `${path.join(os.homedir(), ".local", "bin")}:${env.PATH || ""}` },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ClaudeCliError(`No se pudo lanzar ${bin}: ${e}`, { kind: "exit" }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new ClaudeCliError(`Claude superó el timeout de ${timeoutMs} ms`, { kind: "timeout", stderr }));
      }
      if (code !== 0 && !stdout.trim()) {
        const kind = looksLikeAuthError(stderr) ? "auth" : "exit";
        return reject(new ClaudeCliError(`claude salió con código ${code}: ${stderr.slice(0, 300)}`, { kind, stderr, exitCode: code }));
      }
      try {
        resolve(parseClaudeJson(stdout));
      } catch (e) {
        if (e instanceof ClaudeCliError && !e.stderr) e.stderr = stderr;
        reject(e);
      }
    });

    if (opts.stdin) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}
