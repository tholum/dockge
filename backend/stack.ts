import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
import { DockgeSocket, fileExists, ValidationError } from "./util-server";
import path from "path";
import {
    acceptedComposeFileNames,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    CREATED_STACK,
    EXITED, getCombinedTerminalName,
    getComposeTerminalName, getContainerExecTerminalName,
    PROGRESS_TERMINAL_ROWS,
    RUNNING, TERMINAL_ROWS,
    UNKNOWN
} from "../common/util-common";
import { InteractiveTerminal, Terminal } from "./terminal";
import childProcessAsync from "promisify-child-process";
import { Settings } from "./settings";
import { R } from "redbean-node";

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    protected _composeYAML?: string;
    protected _composeENV?: string;
    protected _configFilePath?: string;
    protected _composeFileName: string = "compose.yaml";
    protected server: DockgeServer;

    protected combinedTerminal? : Terminal;

    protected static managedStackList: Map<string, Stack> = new Map();

    constructor(server : DockgeServer, name : string, composeYAML? : string, composeENV? : string, skipFSOperations = false) {
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;

        if (!skipFSOperations) {
            // Check if compose file name is different from compose.yaml
            const customPath = Stack.pathCache.get(this.name);
            const operationPath = customPath || this.path;
            log.debug("stack", `Checking compose file in ${operationPath} (custom: ${Boolean(customPath)})`);
            for (const filename of acceptedComposeFileNames) {
                const filePath = path.join(operationPath, filename);
                log.debug("stack", `Checking for ${filePath}`);
                if (fs.existsSync(filePath)) {
                    this._composeFileName = filename;
                    log.debug("stack", `Found compose file: ${filename}`);
                    break;
                }
            }
        }
    }

    toJSON(endpoint : string) : object {
        // Since we have multiple agents now, embed primary hostname in the stack object too.
        let primaryHostname = "localhost";
        if (endpoint) {
            // Use the endpoint as the primary hostname
            try {
                primaryHostname = (new URL("https://" + endpoint).hostname);
            } catch (e) {
                // Just in case if the endpoint is in a incorrect format
                primaryHostname = "localhost";
            }
        }

        const obj = this.toSimpleJSON(endpoint);
        return {
            ...obj,
            composeYAML: this.composeYAML,
            composeENV: this.composeENV,
            primaryHostname,
        };
    }

    toSimpleJSON(endpoint : string) : object {
        return {
            name: this.name,
            status: this._status,
            tags: [],
            isManagedByDockge: this.isManagedByDockge,
            composeFileName: this._composeFileName,
            endpoint,
        };
    }

    /**
     * Get the status of the stack from `docker compose ps --format json`
     */
    async ps() : Promise<object> {
        const operationPath = await this.getOperationPath();
        let res = await childProcessAsync.spawn("docker", [ "compose", "ps", "--format", "json" ], {
            cwd: operationPath,
            encoding: "utf-8",
        });
        if (!res.stdout) {
            return {};
        }
        return JSON.parse(res.stdout.toString());
    }

    get isManagedByDockge() : boolean {
        // A stack is considered managed if it's in the default path or has a custom path
        const defaultPath = path.join(this.server.stacksDir, this.name);
        const hasDefaultPath = fs.existsSync(defaultPath) && fs.statSync(defaultPath).isDirectory();
        if (hasDefaultPath) {
            return true;
        }

        // Check for custom path
        const customPath = Stack.pathCache.get(this.name);
        return customPath !== undefined && fs.existsSync(customPath) && fs.statSync(customPath).isDirectory();
    }

    // Cache of custom paths
    private static pathCache: Map<string, string> = new Map();

    // Initialize path cache from database
    static async initPathCache() {
        const paths = await R.findAll("stack");
        Stack.pathCache.clear();
        for (const bean of paths) {
            Stack.pathCache.set(bean.name, bean.directory_path);
        }
    }

    // Update path cache for a specific stack
    static updatePathCache(name: string, path: string | null) {
        if (path) {
            Stack.pathCache.set(name, path);
        } else {
            Stack.pathCache.delete(name);
        }
    }

    get status() : number {
        return this._status;
    }

    async validate() {
        // Check name, allows [a-z][0-9] _ - only
        if (!this.name.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }

        // Get compose files
        const [composeYAML, composeENV] = await Promise.all([
            this.getComposeYAML(),
            this.getComposeENV()
        ]);

        // Check YAML format
        yaml.parse(composeYAML);

        let lines = composeENV.split("\n");

        // Check if the .env is able to pass docker-compose
        // Prevent "setenv: The parameter is incorrect"
        // It only happens when there is one line and it doesn't contain "="
        if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0) {
            throw new ValidationError("Invalid .env format");
        }
    }

    get composeYAML() : string {
        if (this._composeYAML === undefined) {
            try {
                const operationPath = this.getOperationPath();
                log.debug("stack", `Reading compose file from ${operationPath}`);
                this._composeYAML = fs.readFileSync(path.join(operationPath, this._composeFileName), "utf-8");
            } catch (e) {
                log.error("stack", `Failed to read compose file: ${e instanceof Error ? e.message : String(e)}`);
                this._composeYAML = "";
            }
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            try {
                const operationPath = this.getOperationPath();
                log.debug("stack", `Reading env file from ${operationPath}`);
                this._composeENV = fs.readFileSync(path.join(operationPath, ".env"), "utf-8");
            } catch (e) {
                // Only log as debug since .env is optional
                log.debug("stack", `No .env file found: ${e instanceof Error ? e.message : String(e)}`);
                this._composeENV = "";
            }
        }
        return this._composeENV;
    }

    get path() : string {
        return path.join(this.server.stacksDir, this.name);
    }

    getOperationPath() : string {
        // For Docker Compose operations, try to get custom path from cache
        const customPath = this.getCustomPath();
        return customPath || this.path;
    }

    getCustomPath() : string | null {
        return Stack.pathCache.get(this.name) || null;
    }

    async setCustomPath(directoryPath: string) : Promise<void> {
        // Validate that the directory exists and contains a compose file
        if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
            throw new ValidationError("Directory does not exist");
        }

        // Check if any compose file exists in the directory
        let hasComposeFile = false;
        for (const filename of acceptedComposeFileNames) {
            if (fs.existsSync(path.join(directoryPath, filename))) {
                hasComposeFile = true;
                break;
            }
        }

        if (!hasComposeFile) {
            throw new ValidationError("No compose file found in directory");
        }

        // Save or update the custom path using SQLite's UPSERT
        try {
            await R.exec(
                "INSERT INTO stack (name, directory_path, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now')) " +
                "ON CONFLICT(name) DO UPDATE SET directory_path = ?, updated_at = datetime('now')",
                [this.name, directoryPath, directoryPath]
            );
            // Update the path cache
            Stack.updatePathCache(this.name, directoryPath);
        } catch (e) {
            log.error("stack", `Failed to save stack path: ${e instanceof Error ? e.message : String(e)}`);
            throw new ValidationError("Failed to save stack path");
        }
    }

    get fullPath() : string {
        let dir = this.path;

        // Compose up via node-pty
        let fullPathDir;

        // if dir is relative, make it absolute
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    /**
     * Save the stack to the disk
     * @param isAdd
     */
    async save(isAdd : boolean) {
        await this.validate();

        let dir = this.path;

        // Check if the name is used if isAdd
        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            // Create the stack folder
            await fsAsync.mkdir(dir);
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }
        }

        // Get compose files
        const [composeYAML, composeENV] = await Promise.all([
            this.getComposeYAML(),
            this.getComposeENV()
        ]);

        // Write or overwrite the compose.yaml
        await fsAsync.writeFile(path.join(dir, this._composeFileName), composeYAML);

        const envPath = path.join(dir, ".env");

        // Write or overwrite the .env
        // If .env is not existing and the composeENV is empty, we don't need to write it
        if (await fileExists(envPath) || composeENV.trim() !== "") {
            await fsAsync.writeFile(envPath, composeENV);
        }
    }

    async deploy(socket : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const operationPath = this.getOperationPath();
        log.debug("stack", `Deploying in ${operationPath}`);
        try {
            let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "up", "-d", "--remove-orphans" ], operationPath);
            if (exitCode !== 0) {
                throw new Error("Failed to deploy, please check the terminal output for more information.");
            }
            return exitCode;
        } catch (e) {
            log.error("stack", `Deploy error: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
        }
    }

    async delete(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const operationPath = this.getOperationPath();
        log.debug("stack", `Deleting in ${operationPath}`);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "down", "--remove-orphans" ], operationPath);
        if (exitCode !== 0) {
            throw new Error("Failed to delete, please check the terminal output for more information.");
        }

        // Remove the stack folder if it's managed by Dockge
        if (this.isManagedByDockge) {
            log.debug("stack", `Removing stack folder: ${this.path}`);
            await fsAsync.rm(this.path, {
                recursive: true,
                force: true
            });
        }

        // Remove the custom path if it exists
        log.debug("stack", `Removing custom path for ${this.name}`);
        await R.exec("DELETE FROM stack WHERE name = ?", [this.name]);
        Stack.updatePathCache(this.name, null);

        return exitCode;
    }

    async updateStatus() {
        let statusList = await Stack.getStatusList();
        let status = statusList.get(this.name);

        if (status) {
            this._status = status;
        } else {
            this._status = UNKNOWN;
        }
    }

    /**
     * Checks if a compose file exists in the specified directory.
     * @async
     * @static
     * @param {string} stacksDir - The directory of the stack.
     * @param {string} filename - The name of the directory to check for the compose file.
     * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
     */
    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = path.join(stacksDir, filename);
        // Check if any compose file exists
        for (const filename of acceptedComposeFileNames) {
            let composeFile = path.join(filenamePath, filename);
            if (await fileExists(composeFile)) {
                return true;
            }
        }
        return false;
    }

    static async getStackList(server : DockgeServer, useCacheForManaged = false) : Promise<Map<string, Stack>> {
        let stacksDir = server.stacksDir;
        let stackList : Map<string, Stack>;

        // Use cached stack list?
        if (useCacheForManaged && this.managedStackList.size > 0) {
            stackList = this.managedStackList;
        } else {
            stackList = new Map<string, Stack>();

            // Scan the stacks directory, and get the stack list
            let filenameList = await fsAsync.readdir(stacksDir);

            for (let filename of filenameList) {
                try {
                    // Check if it is a directory
                    let stat = await fsAsync.stat(path.join(stacksDir, filename));
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    // If no compose file exists, skip it
                    if (!await Stack.composeFileExists(stacksDir, filename)) {
                        continue;
                    }
                    let stack = await this.getStack(server, filename);
                    stack._status = CREATED_FILE;
                    stackList.set(filename, stack);
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("getStackList", `Failed to get stack ${filename}, error: ${e.message}`);
                    }
                }
            }

            // Cache by copying
            this.managedStackList = new Map(stackList);
        }

        // Get status from docker compose ls
        let res = await childProcessAsync.spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return stackList;
        }

        let composeList = JSON.parse(res.stdout.toString());

        for (let composeStack of composeList) {
            let stack = stackList.get(composeStack.Name);

            // This stack probably is not managed by Dockge, but we still want to show it
            if (!stack) {
                // Skip the dockge stack if it is not managed by Dockge
                if (composeStack.Name === "dockge") {
                    continue;
                }
                stack = new Stack(server, composeStack.Name);
                stackList.set(composeStack.Name, stack);
            }

            stack._status = this.statusConvert(composeStack.Status);
            stack._configFilePath = composeStack.ConfigFiles;
        }

        return stackList;
    }

    /**
     * Get the status list, it will be used to update the status of the stacks
     * Not all status will be returned, only the stack that is deployed or created to `docker compose` will be returned
     */
    static async getStatusList() : Promise<Map<string, number>> {
        let statusList = new Map<string, number>();

        let res = await childProcessAsync.spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return statusList;
        }

        let composeList = JSON.parse(res.stdout.toString());

        for (let composeStack of composeList) {
            statusList.set(composeStack.Name, this.statusConvert(composeStack.Status));
        }

        return statusList;
    }

    /**
     * Convert the status string from `docker compose ls` to the status number
     * Input Example: "exited(1), running(1)"
     * @param status
     */
    static statusConvert(status : string) : number {
        log.debug("stack", `Converting status: ${status}`);
        if (!status) {
            return UNKNOWN;
        }

        // Parse status string to get counts
        const counts = {
            created: 0,
            exited: 0,
            running: 0
        };

        const parts = status.split(", ");
        for (const part of parts) {
            const match = part.match(/(\w+)\((\d+)\)/);
            if (match) {
                const [, state, count] = match;
                counts[state] = parseInt(count, 10);
            }
        }

        log.debug("stack", `Status counts: ${JSON.stringify(counts)}`);

        // Determine overall status
        if (counts.running > 0 && counts.exited === 0) {
            return RUNNING;
        } else if (counts.exited > 0) {
            return EXITED;
        } else if (counts.created > 0) {
            return CREATED_STACK;
        } else {
            return UNKNOWN;
        }
    }

    static async getStack(server: DockgeServer, stackName: string, skipFSOperations = false) : Promise<Stack> {
        let dir = path.join(server.stacksDir, stackName);

        if (!skipFSOperations) {
            if (!await fileExists(dir) || !(await fsAsync.stat(dir)).isDirectory()) {
                // Maybe it is a stack managed by docker compose directly
                let stackList = await this.getStackList(server, true);
                let stack = stackList.get(stackName);

                if (stack) {
                    return stack;
                } else {
                    // Really not found
                    throw new ValidationError("Stack not found");
                }
            }
        } else {
            //log.debug("getStack", "Skip FS operations");
        }

        let stack : Stack;

        if (!skipFSOperations) {
            stack = new Stack(server, stackName);
        } else {
            stack = new Stack(server, stackName, undefined, undefined, true);
        }

        stack._status = UNKNOWN;
        stack._configFilePath = path.resolve(dir);
        return stack;
    }

    async start(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const operationPath = await this.getOperationPath();
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "up", "-d", "--remove-orphans" ], operationPath);
        if (exitCode !== 0) {
            throw new Error("Failed to start, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async stop(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const operationPath = await this.getOperationPath();
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "stop" ], operationPath);
        if (exitCode !== 0) {
            throw new Error("Failed to stop, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async restart(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const operationPath = await this.getOperationPath();
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "restart" ], operationPath);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async down(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const stackPath = await this.getPath();
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "down" ], stackPath);
        if (exitCode !== 0) {
            throw new Error("Failed to down, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async update(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const operationPath = await this.getOperationPath();
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "pull" ], operationPath);
        if (exitCode !== 0) {
            throw new Error("Failed to pull, please check the terminal output for more information.");
        }

        // If the stack is not running, we don't need to restart it
        await this.updateStatus();
        log.debug("update", "Status: " + this.status);
        if (this.status !== RUNNING) {
            return exitCode;
        }

        exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "up", "-d", "--remove-orphans" ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async joinCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, "docker", [ "compose", "logs", "-f", "--tail", "100" ], this.path);
        terminal.enableKeepAlive = true;
        terminal.rows = COMBINED_TERMINAL_ROWS;
        terminal.cols = COMBINED_TERMINAL_COLS;
        terminal.join(socket);
        terminal.start();
    }

    async leaveCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getTerminal(terminalName);
        if (terminal) {
            terminal.leave(socket);
        }
    }

    async joinContainerTerminal(socket: DockgeSocket, serviceName: string, shell : string = "sh", index: number = 0) {
        const terminalName = getContainerExecTerminalName(socket.endpoint, this.name, serviceName, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            terminal = new InteractiveTerminal(this.server, terminalName, "docker", [ "compose", "exec", serviceName, shell ], this.path);
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();
    }

    async getServiceStatusList() {
        let statusList = new Map<string, number>();

        try {
            let res = await childProcessAsync.spawn("docker", [ "compose", "ps", "--format", "json" ], {
                cwd: this.path,
                encoding: "utf-8",
            });

            if (!res.stdout) {
                return statusList;
            }

            let lines = res.stdout?.toString().split("\n");

            for (let line of lines) {
                try {
                    let obj = JSON.parse(line);
                    if (obj.Health === "") {
                        statusList.set(obj.Service, obj.State);
                    } else {
                        statusList.set(obj.Service, obj.Health);
                    }
                } catch (e) {
                }
            }

            return statusList;
        } catch (e) {
            log.error("getServiceStatusList", e);
            return statusList;
        }

    }
}
