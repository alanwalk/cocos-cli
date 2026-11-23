import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_ASAR_HEADER_BYTES = 32 * 1024 * 1024;

function normalizeVersion(value) {
    if (typeof value !== "string") {
        return null;
    }
    const version = value.trim().replace(/^v/, "");
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

function readExactly(descriptor, length, position, fileSize) {
    if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0 || length > fileSize - position) {
        return null;
    }
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
        const count = readSync(descriptor, buffer, bytesRead, length - bytesRead, position + bytesRead);
        if (count === 0) {
            return null;
        }
        bytesRead += count;
    }
    return buffer;
}

function withFile(filePath, callback) {
    let descriptor;
    try {
        descriptor = openSync(filePath, "r");
        const stats = fstatSync(descriptor);
        if (!stats.isFile() || !Number.isSafeInteger(stats.size)) {
            return null;
        }
        return callback(descriptor, stats.size);
    } catch {
        return null;
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
}

function readMetadata(filePath) {
    return withFile(filePath, (descriptor, fileSize) => {
        if (fileSize === 0 || fileSize > MAX_METADATA_BYTES) {
            return null;
        }
        return readExactly(descriptor, fileSize, 0, fileSize)?.toString("utf8") ?? null;
    });
}

function packageVersion(content) {
    if (content === null) {
        return null;
    }
    try {
        return normalizeVersion(JSON.parse(content.replace(/^\uFEFF/, "")).version);
    } catch {
        return null;
    }
}

function readAsarPackage(archivePath, pathApi) {
    return withFile(archivePath, (descriptor, fileSize) => {
        // ASAR begins with two Chromium Pickles: an 8-byte size pickle and
        // a JSON-header pickle containing a 4-byte payload size and string size.
        const prefix = readExactly(descriptor, 16, 0, fileSize);
        if (!prefix || prefix.readUInt32LE(0) !== 4) {
            return null;
        }
        const headerSize = prefix.readUInt32LE(4);
        const payloadSize = prefix.readUInt32LE(8);
        const jsonSize = prefix.readUInt32LE(12);
        if (headerSize < 8 || headerSize > MAX_ASAR_HEADER_BYTES || headerSize % 4 !== 0 || payloadSize !== headerSize - 4 || jsonSize === 0 || jsonSize > headerSize - 8 || headerSize > fileSize - 8) {
            return null;
        }
        const header = readExactly(descriptor, jsonSize, 16, fileSize);
        if (!header) {
            return null;
        }
        let entry;
        try {
            entry = JSON.parse(header.toString("utf8")).files?.["package.json"];
        } catch {
            return null;
        }
        if (!entry || typeof entry !== "object" || entry.link || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_METADATA_BYTES) {
            return null;
        }
        if (entry.unpacked === true) {
            const packagePath = pathApi.join(`${archivePath}.unpacked`, "package.json");
            const version = packageVersion(readMetadata(packagePath));
            return version ? { actualVersion: version, versionSource: packagePath } : null;
        }
        // Do not coerce an arbitrary JSON offset to Number: it can lose precision
        // or point outside the archive. Only the root package entry is read.
        if (typeof entry.offset !== "string" || !/^\d{1,16}$/.test(entry.offset)) {
            return null;
        }
        const offset = Number(entry.offset);
        const position = 8 + headerSize + offset;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(position)) {
            return null;
        }
        const content = readExactly(descriptor, entry.size, position, fileSize);
        const version = packageVersion(content?.toString("utf8") ?? null);
        return version ? { actualVersion: version, versionSource: `${archivePath}!/package.json` } : null;
    });
}

function readPlistVersion(filePath) {
    const content = readMetadata(filePath);
    if (!content || content.startsWith("bplist")) {
        return null;
    }
    // Electron app bundles normally ship an XML plist. Unsupported/binary
    // plists remain unknown; no external program or GUI is launched to decode it.
    for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
        const match = content.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`));
        const version = normalizeVersion(match?.[1]);
        if (version) {
            return { actualVersion: version, versionSource: `${filePath}#${key}` };
        }
    }
    return null;
}

export function readCreatorVersion(executablePath: string, options: { platform?: NodeJS.Platform } = {}) {
    const platform = options.platform ?? process.platform;
    const pathApi = platform === "win32" ? win32 : posix;
    let resolvedPath = executablePath;
    try {
        resolvedPath = realpathSync(executablePath);
    } catch {
        // Resolution already checks executability. Missing metadata is reported
        // as unknown rather than using a project version or a directory name.
    }
    const executableDirectory = pathApi.dirname(resolvedPath);
    const contentsDirectory = pathApi.dirname(executableDirectory);
    const isMacBundle = platform === "darwin" && pathApi.basename(executableDirectory) === "MacOS" && pathApi.basename(contentsDirectory) === "Contents";
    const resourcesDirectory = isMacBundle ? pathApi.join(contentsDirectory, "Resources") : pathApi.join(executableDirectory, "resources");
    const packagePath = pathApi.join(resourcesDirectory, "app", "package.json");
    const version = packageVersion(readMetadata(packagePath));
    if (version) {
        return { actualVersion: version, versionSource: packagePath };
    }
    const archiveVersion = readAsarPackage(pathApi.join(resourcesDirectory, "app.asar"), pathApi);
    if (archiveVersion) {
        return archiveVersion;
    }
    if (isMacBundle) {
        const plistVersion = readPlistVersion(pathApi.join(contentsDirectory, "Info.plist"));
        if (plistVersion) {
            return plistVersion;
        }
    }
    return { actualVersion: null, versionSource: null };
}
