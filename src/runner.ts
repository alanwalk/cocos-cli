import { spawn, type StdioOptions } from "node:child_process";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

import { CocosCliError } from "./errors.js";

interface LaunchOptions { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean; logFile?: string }
interface WaitOptions extends LaunchOptions {
    stdio?: StdioOptions;
    timeoutMs?: number;
    forwardOutput?: { stdout: Writable; stderr: Writable };
}
interface ChildResult { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }

export function waitForChild(command: string, args: string[], options: WaitOptions = {}): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            stdio: options.stdio ?? "inherit",
            windowsHide: options.windowsHide ?? true,
        });

        if (options.forwardOutput) {
            child.stdout?.pipe(options.forwardOutput.stdout, { end: false });
            child.stderr?.pipe(options.forwardOutput.stderr, { end: false });
        }
        let timedOut = false;
        const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, options.timeoutMs);
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(
                new CocosCliError(`无法启动 Cocos Creator: ${command}`, {
                    cause: error,
                    code: "CREATOR_START_FAILED",
                }),
            );
        });
        child.once("exit", (code, signal) => {
            clearTimeout(timeout);
            if (options.forwardOutput) {
                // Creator workers can retain inherited pipes even after the build process exits.
                setImmediate(() => {
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    resolve({ code, signal, timedOut });
                });
                return;
            }
            resolve({ code, signal, timedOut });
        });
    });
}

export async function launchDetached(command: string, args: string[], options: LaunchOptions = {}) {
    let logDescriptor;
    try {
        if (options.logFile) {
            mkdirSync(dirname(options.logFile), { recursive: true });
            logDescriptor = openSync(options.logFile, "a", 0o600);
        }
        const child = spawn(command, args, {
            cwd: options.cwd,
            detached: true,
            env: options.env ?? process.env,
            stdio: logDescriptor === undefined ? "ignore" : ["ignore", logDescriptor, logDescriptor],
            windowsHide: options.windowsHide ?? false,
        });

        await once(child, "spawn");
        child.unref();
        return child.pid;
    } catch (error) {
        throw new CocosCliError(`无法启动 Cocos Creator: ${command}`, {
            cause: error,
            code: "CREATOR_START_FAILED",
            details: options.logFile ? [`启动日志: ${options.logFile}`] : [],
        });
    } finally {
        if (logDescriptor !== undefined) closeSync(logDescriptor);
    }
}
