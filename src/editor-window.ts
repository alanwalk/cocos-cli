import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CocosCliError } from "./errors.js";

const execFileAsync = promisify(execFile);

const WINDOWS_WINDOW_API = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CreatorWindow {
    private const int ExtendedStyle = -20;
    private const int NoActivate = 0x08000000;
    private const int Layered = 0x00080000;
    private const int AppWindow = 0x00040000;
    private const uint Alpha = 0x00000002;
    private const uint ShowWindowFlag = 0x0040;
    private const uint KeepGeometryAndFocus = 0x0001 | 0x0002 | 0x0010 | 0x0200; // NOSIZE | NOMOVE | NOACTIVATE | NOOWNERZORDER
    [StructLayout(LayoutKind.Sequential)]
    private struct FlashInfo {
        public uint Size;
        public IntPtr Window;
        public uint Flags;
        public uint Count;
        public uint Timeout;
    }
    private delegate bool WindowCallback(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern int SetWindowLong(IntPtr window, int index, int value);
    [DllImport("user32.dll")] private static extern bool SetLayeredWindowAttributes(IntPtr window, uint colorKey, byte alpha, uint flags);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool FlashWindowEx(ref FlashInfo info);

    public static int PrepareBackgroundStartup(IntPtr window) {
        int style = GetWindowLong(window, ExtendedStyle);
        int added = (NoActivate | Layered) & ~style;
        // Explorer needs APPWINDOW to create a taskbar button while NOACTIVATE is set.
        SetWindowLong(window, ExtendedStyle, style | added | AppWindow);
        if ((added & Layered) != 0 && !SetLayeredWindowAttributes(window, 0, 0, Alpha)) {
            RestoreStartupStyle(window, Layered);
            added &= ~Layered;
        }
        return added;
    }

    public static void RestoreStartupStyle(IntPtr window, int added) {
        if (added == 0) return;
        if ((added & Layered) != 0) SetLayeredWindowAttributes(window, 0, 255, Alpha);
        int style = GetWindowLong(window, ExtendedStyle);
        SetWindowLong(window, ExtendedStyle, style & ~added);
    }

    public static bool PlaceInBackground(IntPtr window, bool show) {
        uint flags = KeepGeometryAndFocus;
        if (show) flags |= ShowWindowFlag;
        return SetWindowPos(window, new IntPtr(1), 0, 0, 0, 0, flags); // HWND_BOTTOM
    }

    public static void StopTaskbarFlash(IntPtr window) {
        var info = new FlashInfo {
            Size = (uint)Marshal.SizeOf(typeof(FlashInfo)),
            Window = window,
            Flags = 0, // FLASHW_STOP
            Count = 0,
            Timeout = 0
        };
        FlashWindowEx(ref info);
    }

    public static bool Owns(IntPtr window, int pid) {
        uint owner;
        return GetWindowThreadProcessId(window, out owner) != 0 && owner == pid;
    }

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
`;

const WINDOWS_WINDOW_SCRIPT = String.raw`
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

$activate = $windowMode -eq 'foreground'
if ($keepInBackground) {
    $startupStyle = 0
    try {
        if ($backgroundStartup -and -not [CreatorWindow]::IsWindowVisible($window)) {
            # Creator raises the Loading window on its first show. Position it before it can paint over the current app.
            $startupStyle = [CreatorWindow]::PrepareBackgroundStartup($window)
            while (-not [CreatorWindow]::IsWindowVisible($window) -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt ($deadlineAt - 500)) {
                if ($creator.HasExited) { throw 'Creator exited during startup.' }
                Start-Sleep -Milliseconds 25
            }
        }
        $hidden = -not [CreatorWindow]::IsWindowVisible($window)
        $current = [CreatorWindow]::GetForegroundWindow()
        if ($hidden -or -not [CreatorWindow]::Owns($current, $creatorPid)) {
            if (-not [CreatorWindow]::PlaceInBackground($window, $hidden)) {
                throw 'Could not place the Creator main window in the background.'
            }
        }
    } finally {
        if ([CreatorWindow]::Owns($window, $creatorPid)) {
            [CreatorWindow]::RestoreStartupStyle($window, $startupStyle)
        }
    }
} elseif ($activate) {
    if ([CreatorWindow]::IsIconic($window)) {
        [void][CreatorWindow]::ShowWindowAsync($window, 9)
    } elseif (-not [CreatorWindow]::IsWindowVisible($window)) {
        [void][CreatorWindow]::ShowWindowAsync($window, 5)
    }
} elseif ([CreatorWindow]::IsIconic($window) -or -not [CreatorWindow]::IsWindowVisible($window)) {
    [void][CreatorWindow]::ShowWindowAsync($window, 4) # SW_SHOWNOACTIVATE
}

$restoreDeadline = 0
while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadlineAt) {
    if ($creator.HasExited) { throw 'Creator exited during the window change.' }
    if ([CreatorWindow]::IsWindowVisible($window) -and ($keepInBackground -or -not [CreatorWindow]::IsIconic($window))) {
        if ($activate) { [void][CreatorWindow]::SetForegroundWindow($window) }
        $current = [CreatorWindow]::GetForegroundWindow()
        $frontmost = [CreatorWindow]::Owns($current, $creatorPid)
        if (-not $activate -and $frontmost -and [CreatorWindow]::IsWindow($previousForeground)) {
            if ($restoreDeadline -eq 0) {
                [void][CreatorWindow]::SetForegroundWindow($previousForeground)
                $restoreDeadline = [Math]::Min($deadlineAt - 50, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 500)
            }
            if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $restoreDeadline) {
                Start-Sleep -Milliseconds 50
                continue
            }
        }
        if ($keepInBackground -and -not $frontmost) { [CreatorWindow]::StopTaskbarFlash($window) }
        @{ visible = $true; focused = ($current -eq $window); frontmost = $frontmost } | ConvertTo-Json -Compress
        exit
    }
    Start-Sleep -Milliseconds 50
}
throw 'Creator main window did not reach the requested visibility.'
`;

const MACOS_FOREGROUND_SCRIPT = String.raw`
ObjC.import("AppKit");

function run() {
    const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    return String(app.isNil() ? 0 : app.processIdentifier);
}
`;

const MACOS_WINDOW_SCRIPT = String.raw`
ObjC.import("AppKit");
ObjC.import("CoreGraphics");

function run(args) {
    const pid = Number(args[0]);
    const deadlineAt = Number(args[1]);
    const activate = args[2] === "foreground";
    let previousPid = Number(args[3]);
    const watchActivation = !activate && previousPid > 0 && previousPid !== pid;
    let creator = null;
    let activationDeadline = 0;
    let nextWindowCheck = 0;
    let visible = false;
    while (Date.now() < deadlineAt) {
        if (creator === null) {
            const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
            if (!app.isNil()) {
                if (ObjC.unwrap(app.executableURL.lastPathComponent) !== "CocosCreator") {
                    throw new Error("The PID no longer belongs to Creator.");
                }
                creator = app;
            }
        } else if (creator.terminated) {
            throw new Error("Creator exited before its main window became visible.");
        }

        if (creator !== null && creator.finishedLaunching && creator.activationPolicy === $.NSApplicationActivationPolicyRegular) {
            const now = Date.now();
            const frontmost = creator.active;
            if (watchActivation) {
                if (!frontmost) {
                    const current = $.NSWorkspace.sharedWorkspace.frontmostApplication;
                    if (!current.isNil() && current.processIdentifier !== pid) previousPid = current.processIdentifier;
                    activationDeadline = 0;
                } else if (activationDeadline === 0) {
                    // Creator can activate its loading screen before its main window is on screen.
                    const previous = $.NSRunningApplication.runningApplicationWithProcessIdentifier(previousPid);
                    if (!previous.isNil() && !previous.terminated) {
                        previous.activateWithOptions(0);
                        activationDeadline = Math.min(deadlineAt - 100, now + 500);
                    }
                }
            }

            if (now >= nextWindowCheck) {
                nextWindowCheck = now + 100;
                visible = false;
                if (creator.hidden) {
                    // JXA invokes no-argument Objective-C methods as properties.
                    creator.unhide;
                } else {
                    const info = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID);
                    const windows = ObjC.deepUnwrap(ObjC.castRefToObject(info));
                    if (!Array.isArray(windows)) throw new Error("Could not query the macOS window server.");
                    visible = windows.some(window => window.kCGWindowOwnerPID === pid && window.kCGWindowLayer === 0
                        && window.kCGWindowBounds.Width > 0 && window.kCGWindowBounds.Height > 0
                        // A window title may be absent without Screen Recording permission.
                        && (window.kCGWindowName == null || / - Cocos Creator 3\.[\d.]+(?:[-+][\w.-]+)?$/.test(window.kCGWindowName)));
                }
            }
            if (visible && activate && !frontmost && activationDeadline === 0) {
                creator.activateWithOptions(0);
                activationDeadline = Math.min(deadlineAt - 100, now + 500);
            }
            if (visible && (frontmost === activate || now >= activationDeadline)) {
                // A foreground app's key window requires an Accessibility query.
                return JSON.stringify({ visible: true, focused: frontmost ? null : false, frontmost });
            }
        }

        // AppKit updates the running application's properties on the main run loop.
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(watchActivation ? 0.01 : 0.1));
    }
    throw new Error("Creator's main window did not become visible.");
}
`;

export type WindowMode = "foreground" | "background";

export function supportsEditorWindowModes(platform: NodeJS.Platform) {
    return platform === "win32" || platform === "darwin";
}

export function assertWindowMode(mode: unknown, platform = process.platform) {
    if (mode === undefined) return;
    if (mode !== "foreground" && mode !== "background") {
        throw new CocosCliError("windowMode 必须是 foreground 或 background", { code: "INVALID_ARGUMENT" });
    }
    if (!supportsEditorWindowModes(platform)) {
        throw new CocosCliError("Creator 主窗口前后台模式目前支持 Windows 和 macOS", { code: "EDITOR_WINDOW_UNSUPPORTED" });
    }
}

async function runWindowScript(windowsScript: string, macScript: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) {
    const options = { env, timeout: timeoutMs, windowsHide: true, encoding: "utf8" as const };
    if (process.platform === "win32") {
        const encoded = Buffer.from(windowsScript, "utf16le").toString("base64");
        return execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], options);
    }
    return execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", macScript, ...args], options);
}

export async function captureForegroundWindow({ timeoutMs, env }: { timeoutMs: number; env?: NodeJS.ProcessEnv }) {
    if (timeoutMs <= 0) return null;
    try {
        const { stdout } = await runWindowScript(
            `${WINDOWS_WINDOW_API}\n[CreatorWindow]::GetForegroundWindow().ToInt64()`, MACOS_FOREGROUND_SCRIPT, [], timeoutMs, env,
        );
        const handle = stdout.trim();
        return /^[1-9]\d*$/.test(handle) ? handle : null;
    } catch {
        return null;
    }
}

export async function setEditorWindow({ pid, mode, timeoutMs, env, previousForeground, backgroundStartup = false, keepInBackground = false }: {
    pid: number;
    mode: WindowMode;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    previousForeground?: string | null;
    backgroundStartup?: boolean;
    keepInBackground?: boolean;
}) {
    assertWindowMode(mode);
    if (!Number.isSafeInteger(pid) || pid <= 0 || timeoutMs <= 0) {
        throw new CocosCliError("无法在剩余时间内定位 Creator 主窗口", { code: "EDITOR_WINDOW_UNAVAILABLE" });
    }
    const deadlineAt = Date.now() + timeoutMs;
    const previous = previousForeground && /^[1-9]\d*$/.test(previousForeground) ? previousForeground : "0";
    const windowsBackground = mode === "background" && process.platform === "win32";
    const startup = windowsBackground && backgroundStartup;
    const keepBehind = windowsBackground && keepInBackground;
    const windowsScript = `$creatorPid = ${pid}\n$windowMode = '${mode}'\n$deadlineAt = ${deadlineAt}\n$previousForeground = [IntPtr]([int64]${previous})\n$backgroundStartup = $${startup}\n$keepInBackground = $${keepBehind}\n${WINDOWS_WINDOW_API}${WINDOWS_WINDOW_SCRIPT}`;
    try {
        // The Windows helper needs time to restore the temporary styles after its own deadline.
        const scriptTimeoutMs = startup ? timeoutMs + 1000 : timeoutMs;
        const { stdout } = await runWindowScript(windowsScript, MACOS_WINDOW_SCRIPT, [String(pid), String(deadlineAt), mode, previous], scriptTimeoutMs, env);
        const outcome = JSON.parse(stdout);
        if (outcome.visible !== true || typeof outcome.frontmost !== "boolean"
            || (typeof outcome.focused !== "boolean" && outcome.focused !== null)) {
            throw new Error("系统没有返回预期的窗口状态");
        }
        return { mode, visible: true, focused: outcome.focused as boolean | null, frontmost: outcome.frontmost as boolean };
    } catch (cause) {
        throw new CocosCliError("无法切换 Creator 主窗口", { code: "EDITOR_WINDOW_CHANGE_FAILED", cause, details: [cause.stderr?.trim() || cause.message] });
    }
}
