import { readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { CocosCliError } from "./errors.js";
import { readJsonFile } from "./files.js";

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject { [key: string]: Json }

export function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function walkJson(value: Json, visit: (value: JsonObject, pointer: string) => void, pointer = ""): void {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => walkJson(entry, visit, pointer + "/" + index));
        return;
    }
    if (!isObject(value)) return;
    visit(value, pointer);
    for (const [key, entry] of Object.entries(value)) {
        const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
        walkJson(entry, visit, pointer + "/" + escaped);
    }
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function assetUuid(value: string): string | undefined {
    const [original, suffix] = value.split("@", 2);
    let uuid: string;
    if (/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(original)) {
        uuid = original.toLowerCase();
    } else if (/^[\da-f]{2}[A-Za-z\d+/]{20}$|^[\da-f]{5}[A-Za-z\d+/]{18}$/i.test(original)) {
        const prefix = original.length === 22 ? 2 : 5;
        let hex = original.slice(0, prefix).toLowerCase();
        for (let index = prefix; index < original.length; index += 2) {
            const pair = (BASE64.indexOf(original[index]) << 6) | BASE64.indexOf(original[index + 1]);
            hex += pair.toString(16).padStart(3, "0");
        }
        uuid = hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    } else {
        return undefined;
    }
    return suffix ? uuid + "@" + suffix : uuid;
}

interface Issue { code: string; file: string; pointer?: string; uuid?: string; related?: string }
interface Reference { uuid: string; file: string; pointer: string; kind: "asset" | "component" }
interface AssetIdentity { path: string; uuid: string }

function indexAssets(projectRoot: string) {
    const identities: AssetIdentity[] = [];
    const references: Reference[] = [];
    const issues: Issue[] = [];
    const assetsRoot = join(projectRoot, "assets");

    function scanDirectory(directory: string) {
        const entries = readdirSync(directory, { withFileTypes: true })
            .filter((entry) => !entry.name.startsWith(".") && !entry.isSymbolicLink())
            .sort((left, right) => left.name.localeCompare(right.name));
        const byName = new Map(entries.map((entry) => [entry.name, entry]));
        for (const entry of entries) {
            const fullPath = join(directory, entry.name);
            const file = relative(projectRoot, fullPath).split(sep).join("/");
            if (entry.isFile() && entry.name.endsWith(".meta")) {
                const sourceName = entry.name.slice(0, -5);
                const source = byName.get(sourceName);
                if (!source) issues.push({ code: "ORPHAN_META", file });
                const meta = readAssetJson(fullPath, file, issues);
                if (!isObject(meta) || !addIdentity(meta.uuid, file.slice(0, -5), file, "/uuid")) {
                    if (meta !== undefined) issues.push({ code: "INVALID_META_UUID", file });
                }
                if (isObject(meta) && isObject(meta.subMetas)) {
                    for (const [key, subMeta] of Object.entries(meta.subMetas)) {
                        if (!isObject(subMeta) || !addIdentity(subMeta.uuid, file.slice(0, -5), file, "/subMetas/" + key + "/uuid")) {
                            issues.push({ code: "INVALID_SUB_ASSET_UUID", file, pointer: "/subMetas/" + key });
                        }
                    }
                }
                continue;
            }
            if (!entry.isFile() && !entry.isDirectory()) continue;
            if (!byName.get(entry.name + ".meta")?.isFile()) issues.push({ code: "MISSING_META", file });
            if (entry.isDirectory()) {
                scanDirectory(fullPath);
            } else if ([".scene", ".prefab", ".anim", ".asset", ".mtl", ".material", ".json", ".spriteatlas"].includes(extname(entry.name).toLowerCase())) {
                const data = readAssetJson(fullPath, file, issues);
                if (data === undefined) continue;
                const serialized = Array.isArray(data) && data.some((item) => isObject(item) && typeof item.__type__ === "string");
                walkJson(data, (item, pointer) => {
                    for (const [field, kind] of [["__uuid__", "asset"], ["__type__", "component"]] as const) {
                        const raw = item[field];
                        const uuid = typeof raw === "string" ? assetUuid(raw) : undefined;
                        if (uuid) references.push({ uuid, file, pointer: pointer + "/" + field, kind });
                    }
                    if (!Array.isArray(data) || !serialized || !("__id__" in item)) return;
                    const id = item.__id__;
                    if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id >= data.length || data[id] === null) {
                        issues.push({ code: "INVALID_OBJECT_REFERENCE", file, pointer: pointer + "/__id__" });
                    }
                });
                if (Array.isArray(data) && serialized) {
                    data.forEach((item, index) => {
                        if (item === null) issues.push({ code: "NULL_SERIALIZED_OBJECT", file, pointer: "/" + index });
                    });
                }
            }
        }
    }

    const uuidOwners = new Map<string, AssetIdentity>();
    function addIdentity(raw: Json, assetPath: string, file: string, pointer: string) {
        const uuid = typeof raw === "string" ? assetUuid(raw) : undefined;
        if (!uuid) return false;
        const existing = uuidOwners.get(uuid);
        if (existing) issues.push({ code: "DUPLICATE_UUID", file, pointer, uuid, related: existing.path });
        const item = { path: assetPath, uuid };
        if (!existing) uuidOwners.set(uuid, item);
        identities.push(item);
        return true;
    }

    try {
        scanDirectory(assetsRoot);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // A missing assets directory is invalid, while a disappearing file should be reported by the reader.
        if ((error as NodeJS.ErrnoException).path !== assetsRoot) throw error;
        issues.push({ code: "ASSETS_MISSING", file: "assets" });
    }
    return { identities, references, issues, uuidOwners };
}

function readAssetJson(fullPath: string, file: string, issues: Issue[]): Json | undefined {
    try {
        return readJsonFile(fullPath, "Creator 资源") as Json;
    } catch {
        issues.push({ code: "INVALID_ASSET_JSON", file });
        return undefined;
    }
}

export function checkAssets(projectRoot: string) {
    const { identities, references, issues, uuidOwners } = indexAssets(projectRoot);
    // Internal assets and importer-generated references can legitimately be absent from assets/.
    const unresolved = references.filter((reference) => !uuidOwners.has(reference.uuid));
    return { ok: issues.length === 0, projectRoot, assetIdentities: identities.length, issues, unresolved };
}

export function findAssetReferences(projectRoot: string, target: string) {
    const { identities, references, issues } = indexAssets(projectRoot);
    const requestedUuid = assetUuid(target);
    const matched = new Set<string>();
    if (requestedUuid) {
        matched.add(requestedUuid);
    } else {
        const resourcePath = target.replace(/^db:\/\//, "");
        const relativePath = relative(projectRoot, resolve(projectRoot, resourcePath)).split(sep).join("/");
        for (const item of identities) {
            if (item.path === relativePath) matched.add(item.uuid);
        }
        if (!matched.size) throw new CocosCliError("资源路径没有可识别的 .meta UUID", { code: "ASSET_NOT_FOUND", details: [target] });
    }

    const incoming = references.filter((reference) => matched.has(reference.uuid) || matched.has(reference.uuid.split("@")[0]));
    return { ok: true, projectRoot, target, uuids: [...matched], references: incoming, issues };
}
