import os from "os";
import {
    CallToolRequestSchema,
    CallToolResult,
    ListToolsRequestSchema,
    ListToolsResult
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { verbose_log } from "./logging.js";
import {
    DEFAULT_TIMEOUT_MS, IS_WINDOWS, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, PIPE_GRACE_MS, WINDOWS_SHELL, runProcess,
} from "./run_process.js";

const SHELL_DESCRIPTION = !IS_WINDOWS
    ? "the system shell (/bin/sh)"
    : WINDOWS_SHELL === "powershell"
        ? "Windows PowerShell (powershell.exe -NoProfile -NonInteractive -Command), with UTF-8 input and output"
        : "cmd.exe";

const TOOL_DESCRIPTION = [
    `Run a process on this ${os.platform()} machine.`,
    `command_line runs in ${SHELL_DESCRIPTION}; argv starts the program directly.`,
    `The result lists EXIT_CODE, then NOTE, STDOUT and STDERR when present, each labeled in its text.`,
    `On timeout or cancellation the whole process tree is killed and the output so far is returned.`,
    `A call returns when the process exits, or ${PIPE_GRACE_MS} ms later if a background process it started still holds its output.`,
    `For work longer than the timeout, start a separate background process that writes its own log, then check the log in later calls`
    + (IS_WINDOWS ? ` (e.g. Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-File','<script.ps1>').` : "."),
    `STDOUT and STDERR are each limited to ${MAX_OUTPUT_BYTES} bytes; the rest is dropped and reported in a NOTE.`,
].join(" ");

export function registerTools(server: Server) {
    server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
        verbose_log("INFO: ListTools");
        return {
            tools: [
                {
                    name: "run_process",
                    description: TOOL_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            command_line: {
                                type: "string",
                                description: `Shell mode: a command line run by ${SHELL_DESCRIPTION}. Cannot be combined with 'argv'.`
                            },
                            argv: {
                                minItems: 1,
                                type: "array",
                                items: { type: "string" },
                                description: "Executable mode: argv[0] is the program, the rest are its arguments, passed without shell interpretation. Cannot be combined with 'command_line'."
                            },
                            cwd: {
                                type: "string",
                                description: "Optional working directory",
                            },
                            stdin_text: {
                                type: "string",
                                description: "Optional text written to STDIN, then STDIN is closed. Useful for long scripts or file contents.",
                            },
                            timeout_ms: {
                                type: "number",
                                description: `Optional timeout in milliseconds, default ${DEFAULT_TIMEOUT_MS}, limited to ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}`,
                            }
                        },
                    },
                },
            ],
        };
    });

    server.setRequestHandler(
        CallToolRequestSchema,
        async (request, extra): Promise<CallToolResult> => {
            verbose_log("INFO: ToolRequest", request);
            if (request.params.name !== "run_process") {
                throw new Error("Unknown tool");
            }
            if (!request.params.arguments) {
                throw new Error("Missing arguments for run_process");
            }
            // extra.signal fires when the client cancels the request
            const result = await runProcess(request.params.arguments, extra.signal);
            verbose_log("INFO: ToolResponse", result);
            return result;
        }
    );
}
