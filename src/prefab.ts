import { extname, resolve } from "node:path";
import { isObject, type Json, type JsonObject } from "./assets.js";
import { CocosCliError } from "./errors.js";
import { readJsonFile } from "./files.js";

interface PrefabNode {
    path: string;
    id: number;
    name: string | null;
    components: { id: number; type: string | null; fields: JsonObject }[];
    children: PrefabNode[];
}

function referenceId(value: Json | undefined) {
    if (!isObject(value) || typeof value.__id__ !== "number" || !Number.isInteger(value.__id__)) return undefined;
    return value.__id__;
}

function readPrefab(projectRoot: string, file: string) {
    const filePath = resolve(projectRoot, file);
    if (extname(filePath).toLowerCase() !== ".prefab") {
        throw new CocosCliError("请输入 .prefab 文件", { code: "INVALID_ARGUMENT", details: [filePath] });
    }
    const data: unknown = readJsonFile(filePath, "Prefab");
    if (!Array.isArray(data) || !isObject(data[0]) || data[0].__type__ !== "cc.Prefab") {
        throw new CocosCliError("无法识别 Creator 3.x Prefab 数据", { code: "INVALID_PREFAB", details: [filePath] });
    }
    const rootId = referenceId(data[0].data);
    if (rootId === undefined) throw new CocosCliError("Prefab 缺少根节点引用", { code: "INVALID_PREFAB", details: [filePath] });
    const knownIds = new Map<number, string>([[0, "$prefab"]]);

    function readObject(id: number | undefined, owner: string): JsonObject {
        if (id !== undefined && isObject((data as Json[])[id])) return (data as JsonObject[])[id];
        throw new CocosCliError("Prefab 包含无效的对象引用", { code: "INVALID_PREFAB", details: [filePath, owner] });
    }

    function readNode(id: number | undefined, parent: string, siblings: Map<string, number>): PrefabNode {
        if (id === undefined) throw new CocosCliError("Prefab 子节点缺少引用", { code: "INVALID_PREFAB", details: [filePath, parent] });
        const node = readObject(id, parent);
        if (node.__type__ !== "cc.Node" || knownIds.has(id)) {
            throw new CocosCliError("Prefab 节点类型错误或存在重复节点引用", { code: "INVALID_PREFAB", details: [filePath, String(id)] });
        }
        const name = typeof node._name === "string" ? node._name : null;
        const label = name || "(unnamed)";
        const next = (siblings.get(label) ?? 0) + 1;
        siblings.set(label, next);
        const nodePath = parent + "/" + encodeURIComponent(label) + "[" + next + "]";
        knownIds.set(id, nodePath);
        const componentCounts = new Map<string, number>();
        const componentRefs = Array.isArray(node._components) ? node._components : [];
        const components = componentRefs.map((ref) => {
            const componentId = referenceId(ref);
            const component = readObject(componentId, nodePath);
            const type = typeof component.__type__ === "string" ? component.__type__ : null;
            const occurrence = (componentCounts.get(type ?? "") ?? 0) + 1;
            componentCounts.set(type ?? "", occurrence);
            knownIds.set(componentId!, nodePath + "@" + (type ?? "component") + "[" + occurrence + "]");
            return { id: componentId!, type, fields: component };
        });
        const childNames = new Map<string, number>();
        const childRefs = Array.isArray(node._children) ? node._children : [];
        const children = childRefs.map((ref) => {
            return readNode(referenceId(ref), nodePath, childNames);
        });
        return { path: nodePath, id, name, components, children };
    }

    const root = readNode(rootId, "", new Map());
    return { filePath, data: data as Json[], root, knownIds };
}

export function inspectPrefab(projectRoot: string, file: string) {
    const { filePath, data, root } = readPrefab(projectRoot, file);
    return { ok: true, file: filePath, objects: data.length, root };
}

function normalizeReferences(value: Json, knownIds: Map<number, string>): Json {
    if (Array.isArray(value)) return value.map((item) => normalizeReferences(item, knownIds));
    if (!isObject(value)) return value;
    const id = referenceId(value);
    if (id !== undefined && knownIds.has(id)) return { ...value, __id__: knownIds.get(id)! };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeReferences(item, knownIds)]));
}

function indexPrefab(prefab: ReturnType<typeof readPrefab>) {
    const index: JsonObject = {};
    prefab.data.forEach((record, id) => {
        const key = prefab.knownIds.get(id) ?? "$objects/" + id;
        index[key] = normalizeReferences(record, prefab.knownIds);
    });
    return index;
}

interface Difference { path: string; before?: Json; after?: Json }
function compare(left: Json | undefined, right: Json | undefined, pointer: string, result: Difference[]) {
    if (left === right) return;
    if ((Array.isArray(left) && Array.isArray(right)) || (isObject(left) && isObject(right))) {
        const keys = new Set([...Object.keys(left!), ...Object.keys(right!)]);
        const leftEntries = left as unknown as JsonObject;
        const rightEntries = right as unknown as JsonObject;
        for (const key of [...keys].sort()) {
            const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
            const before = Object.hasOwn(leftEntries, key) ? leftEntries[key] : undefined;
            const after = Object.hasOwn(rightEntries, key) ? rightEntries[key] : undefined;
            compare(before, after, pointer + "/" + escaped, result);
        }
        return;
    }
    result.push({ path: pointer, before: left, after: right });
}

export function diffPrefabs(projectRoot: string, before: string, after: string) {
    const left = readPrefab(projectRoot, before);
    const right = readPrefab(projectRoot, after);
    const changes: Difference[] = [];
    compare(indexPrefab(left), indexPrefab(right), "", changes);
    return { ok: true, before: left.filePath, after: right.filePath, changed: changes.length > 0, changes };
}
