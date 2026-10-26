import { ChildProcess, spawn, SpawnOptions } from "child_process";
import { performance } from "perf_hooks";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { is_verbose, verbose_log } from "./logging.js";
import { errorResult, resultFor } from "./messages.js";

export const IS_WINDOWS = process.platform === "win32";

function envInt(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
// mcp-proxy gives up at 90 s and Cloudflare at ~100 s, so stay below both by default
export const MAX_TIMEOUT_MS = envInt("MCP_MAX_TIMEOUT_MS", 85_000);
// per stream (stdout, stderr)
export const MAX_OUTPUT_BYTES = envInt("MCP_MAX_OUTPUT_BYTES", 1024 * 1024);
// after the process exits, wait this long for its output pipes to close; a background child may keep them open forever
export const PIPE_GRACE_MS = 500;
// after killing the process tree, return at the latest this long later
const KILL_GRACE_MS = 2_000;

// Windows shell for command_line: PowerShell by default, MCP_SHELL=cmd switches back to cmd.exe
export const WINDOWS_SHELL = process.env.MCP_SHELL?.toLowerCase() === "cmd" ? "cmd" : "powershell";
// make PowerShell read and write UTF-8 (the server decodes output as UTF-8; the default code page is 936)
const PS_PREFIX =
    "$OutputEncoding=[Text.UTF8Encoding]::new($false); " +
    "try{[Console]::OutputEncoding=$OutputEncoding}catch{}; " +
    "try{[Console]::InputEncoding=$OutputEncoding}catch{}; " +
    "$ProgressPreference='SilentlyContinue'; ";

export type SpawnResult = {
    stdout: string;
    stderr: string;
    code?: number;
    signal?: string;
    message?: string;
    notes?: string[];
};

export type RunProcessArgs = Record<string, unknown>;

/** Clamp timeout_ms to MIN..MAX; missing or non-numeric values use the default. */
export function clampTimeout(value: unknown): number {
    const n = Number(value);
    if (value == null || value === "" || Number.isNaN(n)) {
        return Math.min(DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    }
    return Math.min(Math.max(n, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/** Keeps the first MAX_OUTPUT_BYTES of a stream as raw bytes and decodes once at the end. */
class OutputBuffer {
    private chunks: Buffer[] = [];
    private kept = 0;
    dropped = 0;

    add(chunk: Buffer) {
        const take = Math.max(0, Math.min(MAX_OUTPUT_BYTES - this.kept, chunk.length));
        if (take > 0) {
            this.chunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
            this.kept += take;
        }
        this.dropped += chunk.length - take;
    }

    text(): string {
        return Buffer.concat(this.chunks).toString("utf8");
    }
}

/** Kill the process and everything it started. */
function killTree(child: ChildProcess) {
    const pid = child.pid;
    if (!pid) return;
    if (IS_WINDOWS) {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
        return;
    }
    // non-Windows children are started detached, so -pid is their process group
    const signalGroup = (signal: NodeJS.Signals) => {
        try { process.kill(-pid, signal); } catch { child.kill(signal); }
    };
    signalGroup("SIGTERM");
    setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
}

type SpawnPlan = { command: string; args: string[]; shell: boolean };

function spawnPlan(raw: RunProcessArgs): SpawnPlan | string {
    const commandLine = raw.command_line == null ? "" : String(raw.command_line);
    const argv = Array.isArray(raw.argv) ? raw.argv.map(String) : [];
    if (commandLine && argv.length) return "Cannot pass both 'command_line' and 'argv'. Use one or the other.";
    if (!commandLine && !argv.length) return "Either 'command_line' (string) or 'argv' (array) is required.";

    if (argv.length) return { command: argv[0], args: argv.slice(1), shell: false };
    if (IS_WINDOWS && WINDOWS_SHELL === "powershell") {
        return {
            command: "powershell.exe",
            args: ["-NoProfile", "-NonInteractive", "-Command", PS_PREFIX + commandLine],
            shell: false,
        };
    }
    return { command: commandLine, args: [], shell: true };
}

/** The result promise; `pid` is the started process's id (used by tests). */
export type RunProcessPromise = Promise<CallToolResult> & { pid?: number };

export function runProcess(raw: RunProcessArgs, abortSignal?: AbortSignal): RunProcessPromise {
    raw = raw ?? {};
    const plan = spawnPlan(raw);
    if (typeof plan === "string") return Promise.resolve(errorResult(plan));

    const timeoutMs = clampTimeout(raw.timeout_ms);
    const stdinText = raw.stdin_text == null ? "" : String(raw.stdin_text);
    const options: SpawnOptions = {
        shell: plan.shell,
        windowsHide: true,
        // A process group lets killTree reach grandchildren. On Windows, detached means "no console", which breaks
        // console programs (lost output, PowerShell not running at all), so taskkill /T is used there instead.
        detached: !IS_WINDOWS,
        stdio: [stdinText ? "pipe" : "ignore", "pipe", "pipe"],
    };
    if (raw.cwd != null) options.cwd = String(raw.cwd);

    const startTime = performance.now();
    const log = (msg: string, data?: unknown) => {
        if (!is_verbose) return;
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
        verbose_log(`[${elapsed}s] ${msg}`, data);
    };

    let pid: number | undefined;
    const promise: RunProcessPromise = new Promise<CallToolResult>((resolve) => {
        const stdout = new OutputBuffer();
        const stderr = new OutputBuffer();
        const notes: string[] = [];
        const timers: NodeJS.Timeout[] = [];
        let code: number | undefined;
        let signal: string | undefined;
        let message: string | undefined;
        let done = false;
        let stopping = false;
        let child: ChildProcess | undefined;

        const finish = () => {
            if (done) return;
            done = true;
            timers.forEach(clearTimeout);
            abortSignal?.removeEventListener("abort", onAbort);
            // stop reading pipes a background process may still hold
            child?.stdout?.destroy();
            child?.stderr?.destroy();
            if (stdout.dropped) notes.push(`STDOUT truncated: ${stdout.dropped} bytes dropped (limit ${MAX_OUTPUT_BYTES} bytes)`);
            if (stderr.dropped) notes.push(`STDERR truncated: ${stderr.dropped} bytes dropped (limit ${MAX_OUTPUT_BYTES} bytes)`);
            log("RESULT", { code, signal, message, notes });
            resolve(resultFor({ stdout: stdout.text(), stderr: stderr.text(), code, signal, message, notes }));
        };

        const stop = (why: string) => {
            if (done || stopping || !child) return;
            stopping = true;
            notes.push(why);
            log("STOP", why);
            killTree(child);
            timers.push(setTimeout(finish, KILL_GRACE_MS));
        };
        const onAbort = () => stop("cancelled by the client; process tree killed");

        try {
            child = spawn(plan.command, plan.args, options);
        } catch (err) {
            resolve(errorResult(`Failed to start process: ${(err as Error).message}`));
            return;
        }
        pid = child.pid;
        log("SPAWN", { pid, command: plan.command, args: plan.args });

        if (child.stdin) {
            // the child may exit without reading all input (EPIPE); without a listener that error kills the server
            child.stdin.on("error", (err) => log("STDIN_ERROR", err.message));
            child.stdin.end(stdinText);
        }
        child.stdout?.on("data", (chunk: Buffer) => stdout.add(chunk));
        child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));

        child.on("error", (err) => {
            log("ERROR", err.message);
            message = err.message;
            finish();
        });
        child.on("exit", (exitCode, exitSignal) => {
            log("EXIT", { exitCode, exitSignal });
            code = exitCode ?? undefined;
            signal = exitSignal ?? undefined;
            timers.push(setTimeout(() => {
                notes.push(`returned ${PIPE_GRACE_MS} ms after the process exited; its output pipes were still open (probably held by a background process it started)`);
                finish();
            }, PIPE_GRACE_MS));
        });
        child.on("close", () => finish());

        timers.push(setTimeout(() => stop(`timed out after ${timeoutMs} ms; process tree killed`), timeoutMs));
        if (abortSignal?.aborted) onAbort();
        else abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
    promise.pid = pid; // set synchronously above: the executor runs before `new Promise` returns
    return promise;
}
