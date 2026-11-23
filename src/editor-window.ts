import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CocosCliError } from "./errors.js";

const execFileAsync = promisify(execFile);

const WINDOW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CreatorWindow {
    private delegate bool WindowCallback(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public static IntPtr Find(int pid) {
        IntPtr match = IntPtr.Zero;
        int count = 0;
        EnumWindows(delegate(IntPtr window, IntPtr state) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != pid) return true;
            var title = new StringBuilder(512);
            GetWindowText(window, title, title.Capacity);
            if (System.Text.RegularExpressions.Regex.IsMatch(title.ToString(), @" - Cocos Creator 3\.[\d.]+(?:[-+][\w.-]+)?$")) {
                match = window;
                count++;
            }
            return true;
        }, IntPtr.Zero);
        return count == 1 ? match : IntPtr.Zero;
    }
}
'@

$creator = Get-Process -Id $creatorPid -ErrorAction Stop
if ($creator.ProcessName -ne 'CocosCreator') { throw 'The PID no longer belongs to Creator.' }
$window = [IntPtr]::Zero
while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadlineAt) {
    if ($creator.HasExited) { throw 'Creator exited before the main window was available.' }
    $window = [CreatorWindow]::Find($creatorPid)
    if ($window -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 100
}
if ($window -eq [IntPtr]::Zero) { throw 'Creator main window was not found.' }

$show = $windowMode -eq 'foreground'
if ($show) {
    if ([CreatorWindow]::IsIconic($window)) {
        [void][CreatorWindow]::ShowWindowAsync($window, 9)
    } elseif (-not [CreatorWindow]::IsWindowVisible($window)) {
        [void][CreatorWindow]::ShowWindowAsync($window, 5)
    }
} elseif ([CreatorWindow]::IsWindowVisible($window)) {
    [void][CreatorWindow]::ShowWindowAsync($window, 0)
}

while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadlineAt) {
    if ($creator.HasExited) { throw 'Creator exited during the window change.' }
    $visible = [CreatorWindow]::IsWindowVisible($window)
    if ($visible -eq $show -and (-not $show -or -not [CreatorWindow]::IsIconic($window))) {
        if ($show) { [void][CreatorWindow]::SetForegroundWindow($window) }
        @{ visible = $visible; focused = ([CreatorWindow]::GetForegroundWindow() -eq $window) } | ConvertTo-Json -Compress
        exit
    }
    Start-Sleep -Milliseconds 50
}
throw 'Creator main window did not reach the requested visibility.'
`;

export type WindowMode = "foreground" | "background";

export function assertWindowMode(mode: unknown, platform = process.platform) {
    if (mode === undefined) return;
    if (mode !== "foreground" && mode !== "background") {
        throw new CocosCliError("windowMode 必须是 foreground 或 background", { code: "INVALID_ARGUMENT" });
    }
    if (platform !== "win32") {
        throw new CocosCliError("Creator 主窗口显隐选项目前支持 Windows", { code: "EDITOR_WINDOW_UNSUPPORTED" });
    }
}

export async function setEditorWindow({ pid, mode, timeoutMs, env }: { pid: number; mode: WindowMode; timeoutMs: number; env?: NodeJS.ProcessEnv }) {
    assertWindowMode(mode);
    if (!Number.isSafeInteger(pid) || pid <= 0 || timeoutMs <= 0) {
        throw new CocosCliError("无法在剩余时间内定位 Creator 主窗口", { code: "EDITOR_WINDOW_UNAVAILABLE" });
    }
    const deadlineAt = Date.now() + timeoutMs;
    const script = `$creatorPid = ${pid}\n$windowMode = '${mode}'\n$deadlineAt = ${deadlineAt}\n${WINDOW_SCRIPT}`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    try {
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
            env,
            timeout: timeoutMs,
            windowsHide: true,
        });
        const outcome = JSON.parse(stdout);
        if (outcome.visible !== (mode === "foreground") || typeof outcome.focused !== "boolean") {
            throw new Error("系统没有返回预期的窗口状态");
        }
        return { mode, visible: outcome.visible, focused: outcome.focused };
    } catch (cause) {
        throw new CocosCliError("无法切换 Creator 主窗口", { code: "EDITOR_WINDOW_CHANGE_FAILED", cause, details: [cause.stderr?.trim() || cause.message] });
    }
}
