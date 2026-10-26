import fs from "fs";
import { clampTimeout, MAX_OUTPUT_BYTES, runProcess } from "../../src/run_process.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Tests for the fixes in 0.8.2-bmcp.1 (POSIX only; Windows is checked by hand).

const texts = (r: CallToolResult) => r.content.map((c) => String((c as any).text));
const isAlive = (pid: number) => {
    // a killed orphan stays a zombie (state Z) when PID 1 does not reap, as in some containers
    try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z"; } catch { /* no /proc */ }
    try { process.kill(pid, 0); return true; } catch { return false; }
};
const timed = async <T>(p: Promise<T>) => { const t = Date.now(); const v = await p; return { v, ms: Date.now() - t }; };

describe("timeout kills the whole process tree and returns on time", () => {
    test("grandchild started in the background is killed too", async () => {
        const { v, ms } = await timed(runProcess({
            command_line: "sleep 30 & echo $!; sleep 30",
            timeout_ms: 1000,
        }));
        expect(ms).toBeLessThan(3500);
        expect(v.isError).toBe(true);
        expect(texts(v)).toContain("NOTE: timed out after 1000 ms; process tree killed");
        const pid = Number(texts(v).find((t) => t.startsWith("STDOUT:"))!.split("\n")[1]);
        await new Promise((r) => setTimeout(r, 300));
        expect(isAlive(pid)).toBe(false);
    });
});

describe("a background process holding the output pipes does not block the call", () => {
    test("returns shortly after the shell exits", async () => {
        const { v, ms } = await timed(runProcess({ command_line: "sleep 30 & echo $!", timeout_ms: 20000 }));
        expect(ms).toBeLessThan(2000);
        expect(texts(v)[0]).toBe("EXIT_CODE: 0");
        expect(texts(v).some((t) => t.startsWith("NOTE: returned 500 ms after the process exited"))).toBe(true);
        const pid = Number(texts(v).find((t) => t.startsWith("STDOUT:"))!.split("\n")[1]);
        process.kill(pid, "SIGKILL"); // clean up the background sleep
    });
});

describe("cancellation", () => {
    test("abort signal kills the process and returns", async () => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 300);
        const { v, ms } = await timed(runProcess({ argv: ["sleep", "30"], timeout_ms: 20000 }, ac.signal));
        expect(ms).toBeLessThan(2500);
        expect(v.isError).toBe(true);
        expect(texts(v)).toContain("NOTE: cancelled by the client; process tree killed");
    });
});

describe("stdin_text", () => {
    test("child exiting without reading stdin does not crash the server", async () => {
        const v = await runProcess({ argv: ["true"], stdin_text: "x".repeat(4 * 1024 * 1024) });
        expect(texts(v)[0]).toBe("EXIT_CODE: 0");
    });

    test("stdin is passed through", async () => {
        const v = await runProcess({ argv: ["cat"], stdin_text: "中文测试" });
        expect(texts(v)).toEqual(["EXIT_CODE: 0", "STDOUT:\n中文测试"]);
    });
});

describe("output", () => {
    test("multi-byte characters split across chunks are decoded intact", async () => {
        const v = await runProcess({ argv: [process.execPath, "-e", "process.stdout.write('中'.repeat(200000))"] });
        const out = texts(v).find((t) => t.startsWith("STDOUT:"))!;
        expect(out).toBe("STDOUT:\n" + "中".repeat(200000));
    });

    test("output over the limit is truncated with a note", async () => {
        const total = MAX_OUTPUT_BYTES + 12345;
        const v = await runProcess({ argv: [process.execPath, "-e", `process.stdout.write('a'.repeat(${total}))`] });
        const out = texts(v).find((t) => t.startsWith("STDOUT:"))!;
        expect(out.length).toBe("STDOUT:\n".length + MAX_OUTPUT_BYTES);
        expect(texts(v)).toContain(`NOTE: STDOUT truncated: 12345 bytes dropped (limit ${MAX_OUTPUT_BYTES} bytes)`);
    });
});

describe("timeout_ms is clamped", () => {
    test.each([
        [undefined, 30000], ["abc", 30000], [-1, 1000], [0, 1000], [500, 1000],
        [5000, 5000], [1e12, 85000], [Infinity, 85000], ["2000", 2000],
    ])("%p -> %p", (input, expected) => {
        expect(clampTimeout(input)).toBe(expected);
    });
});
