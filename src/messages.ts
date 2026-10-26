import { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { SpawnResult } from "./run_process.js";

// Each part carries its label in the text itself ("EXIT_CODE: 0", "STDOUT:\n..."):
// proxies such as mcp-proxy drop non-standard fields like `name`.
const part = (text: string): TextContent => ({ type: "text", text });

export function resultFor(result: SpawnResult): CallToolResult {
    const out: CallToolResult = { content: messagesFor(result) };
    if (result.code !== 0) out.isError = true;
    return out;
}

export function messagesFor(result: SpawnResult): TextContent[] {
    const messages: TextContent[] = [];
    // always include the exit code so success is explicit; some commands print nothing
    if (result.code !== undefined) messages.push(part(`EXIT_CODE: ${result.code}`));
    if (result.message) messages.push(part(`MESSAGE: ${result.message}`));
    if (result.signal) messages.push(part(`SIGNAL: ${result.signal}`));
    for (const note of result.notes ?? []) messages.push(part(`NOTE: ${note}`));
    if (result.stdout) messages.push(part(`STDOUT:\n${result.stdout}`));
    if (result.stderr) messages.push(part(`STDERR:\n${result.stderr}`));
    return messages;
}

export function errorResult(message: string): CallToolResult {
    return { isError: true, content: [part(`ERROR: ${message}`)] };
}
