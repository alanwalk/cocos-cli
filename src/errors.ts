interface ErrorOptions { code?: string; details?: string[]; cause?: unknown }

export class CocosCliError extends Error {
    readonly code: string;
    readonly details: string[];
    declare reachable?: boolean;
    declare editorVersion?: string;

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = "CocosCliError";
        this.code = options.code ?? "COCOS_CLI_ERROR";
        this.details = options.details ?? [];
    }
}
