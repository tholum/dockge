import { DockgeServer } from "./dockge-server";
import * as os from "node:os";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { LimitQueue } from "./utils/limit-queue";
import { DockgeSocket } from "./util-server";
import {
    allowedCommandList, allowedRawKeys,
    PROGRESS_TERMINAL_ROWS,
    TERMINAL_COLS,
    TERMINAL_ROWS
} from "../common/util-common";
import { sync as commandExistsSync } from "command-exists";
import { log } from "./log";

/**
 * Terminal for running commands, no user interaction
 */
export class Terminal {

    protected static terminalMap : Map<string, Terminal> = new Map();

    protected _ptyProcess? : pty.IPty;
    protected server : DockgeServer;
    protected buffer : LimitQueue<string> = new LimitQueue(100);
    protected _name : string;

    protected file : string;
    protected args : string | string[];
    protected cwd : string;
    protected callback? : (exitCode : number) => void;

    protected _rows : number = TERMINAL_ROWS;
    protected _cols : number = TERMINAL_COLS;

    public enableKeepAlive : boolean = false;
    protected keepAliveInterval? : NodeJS.Timeout;
    protected kickDisconnectedClientsInterval? : NodeJS.Timeout;

    protected socketList : Record<string, DockgeSocket> = {};

    constructor(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string) {
        this.server = server;
        this._name = name;
        //this._name = "terminal-" + Date.now() + "-" + getCryptoRandomInt(0, 1000000);
        this.file = file;
        this.args = args;
        this.cwd = cwd;

        Terminal.terminalMap.set(this.name, this);
    }

    get rows() {
        return this._rows;
    }

    set rows(rows : number) {
        this._rows = rows;
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    get cols() {
        return this._cols;
    }

    set cols(cols : number) {
        this._cols = cols;
        log.debug("Terminal", `Terminal cols: ${this._cols}`); // Added to check if cols is being set when changing terminal size.
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    public start() {
        if (this._ptyProcess) {
            return;
        }

        log.debug("Terminal", `Starting terminal ${this.name} in ${this.cwd}`);
        log.debug("Terminal", `Command: ${this.file} ${this.args.join(' ')}`);

        this.kickDisconnectedClientsInterval = setInterval(() => {
            for (const socketID in this.socketList) {
                const socket = this.socketList[socketID];
                if (!socket.connected) {
                    log.debug("Terminal", "Kicking disconnected client " + socket.id + " from terminal " + this.name);
                    this.leave(socket);
                }
            }
        }, 60 * 1000);

        if (this.enableKeepAlive) {
            log.debug("Terminal", "Keep alive enabled for terminal " + this.name);

            // Close if there is no clients
            this.keepAliveInterval = setInterval(() => {
                const numClients = Object.keys(this.socketList).length;

                if (numClients === 0) {
                    log.debug("Terminal", "Terminal " + this.name + " has no client, closing...");
                    this.close();
                } else {
                    log.debug("Terminal", "Terminal " + this.name + " has " + numClients + " client(s)");
                }
            }, 60 * 1000);
        } else {
            log.debug("Terminal", "Keep alive disabled for terminal " + this.name);
        }

        try {
            // Ensure cwd exists
            if (!fs.existsSync(this.cwd)) {
                throw new Error(`Working directory ${this.cwd} does not exist`);
            }

            this._ptyProcess = pty.spawn(this.file, this.args, {
                name: this.name,
                cwd: this.cwd,
                cols: TERMINAL_COLS,
                rows: this.rows,
                env: process.env
            });

            log.debug("Terminal", `Terminal ${this.name} spawned with PID ${this._ptyProcess.pid}`);

            // On Data
            this._ptyProcess.onData((data) => {
                log.debug("Terminal", `Terminal ${this.name} received data: ${data.length} bytes`);
                this.buffer.pushItem(data);

                // Log the first few bytes of data for debugging
                const preview = data.slice(0, 100).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
                log.debug("Terminal", `Data preview: ${preview}...`);

                for (const socketID in this.socketList) {
                    const socket = this.socketList[socketID];
                    try {
                        socket.emitAgent("terminalWrite", this.name, data);
                        log.debug("Terminal", `Data sent to socket ${socketID}`);
                    } catch (e) {
                        log.error("Terminal", `Failed to send data to socket ${socketID}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            });

            // On Exit
            this._ptyProcess.onExit((event) => {
                log.debug("Terminal", `Terminal ${this.name} exited with code ${event.exitCode}`);
                this.exit(event);
            });
        } catch (error) {
            if (error instanceof Error) {
                clearInterval(this.keepAliveInterval);

                log.error("Terminal", "Failed to start terminal: " + error.message);
                const exitCode = Number(error.message.split(" ").pop()) || 1;
                this.exit({
                    exitCode,
                });
            }
        }
    }

    /**
     * Exit event handler
     * @param res
     */
    protected exit = (res : {exitCode: number, signal?: number | undefined}) => {
        for (const socketID in this.socketList) {
            const socket = this.socketList[socketID];
            socket.emitAgent("terminalExit", this.name, res.exitCode);
        }

        // Remove all clients
        this.socketList = {};

        Terminal.terminalMap.delete(this.name);
        log.debug("Terminal", "Terminal " + this.name + " exited with code " + res.exitCode);

        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);

        if (this.callback) {
            this.callback(res.exitCode);
        }
    };

    public onExit(callback : (exitCode : number) => void) {
        this.callback = callback;
    }

    public join(socket : DockgeSocket) {
        log.debug("Terminal", `Socket ${socket.id} joining terminal ${this.name}`);
        this.socketList[socket.id] = socket;

        // Send current buffer to new socket
        const buffer = this.getBuffer();
        if (buffer) {
            try {
                socket.emitAgent("terminalWrite", this.name, buffer);
                log.debug("Terminal", `Sent buffer to socket ${socket.id}`);
            } catch (e) {
                log.error("Terminal", `Failed to send buffer to socket ${socket.id}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    public leave(socket : DockgeSocket) {
        log.debug("Terminal", `Socket ${socket.id} leaving terminal ${this.name}`);
        delete this.socketList[socket.id];
    }

    public get ptyProcess() {
        return this._ptyProcess;
    }

    public get name() {
        return this._name;
    }

    /**
     * Get the terminal output string
     */
    getBuffer() : string {
        if (this.buffer.length === 0) {
            log.debug("Terminal", `No buffer for terminal ${this.name}`);
            return "";
        }
        const buffer = this.buffer.join("");
        log.debug("Terminal", `Got buffer for terminal ${this.name}: ${buffer.length} bytes`);
        return buffer;
    }

    close() {
        clearInterval(this.keepAliveInterval);
        // Send Ctrl+C to the terminal
        this.ptyProcess?.write("\x03");
    }

    /**
     * Get a running and non-exited terminal
     * @param name
     */
    public static getTerminal(name : string) : Terminal | undefined {
        return Terminal.terminalMap.get(name);
    }

    public static getOrCreateTerminal(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string) : Terminal {
        // Since exited terminal will be removed from the map, it is safe to get the terminal from the map
        let terminal = Terminal.getTerminal(name);
        if (!terminal) {
            terminal = new Terminal(server, name, file, args, cwd);
        }
        return terminal;
    }

    public static exec(server : DockgeServer, socket : DockgeSocket | undefined, terminalName : string, file : string, args : string | string[], cwd : string) : Promise<number> {
        return new Promise((resolve, reject) => {
            // check if terminal exists
            if (Terminal.terminalMap.has(terminalName)) {
                reject("Another operation is already running, please try again later.");
                return;
            }

            log.debug("Terminal", `Creating terminal ${terminalName} in ${cwd}`);
            log.debug("Terminal", `Command: ${file} ${args.join(' ')}`);

            let terminal = new Terminal(server, terminalName, file, args, cwd);
            terminal.rows = PROGRESS_TERMINAL_ROWS;

            if (socket) {
                terminal.join(socket);
                log.debug("Terminal", `Socket ${socket.id} joined terminal ${terminalName}`);
            }

            terminal.onExit((exitCode : number) => {
                log.debug("Terminal", `Terminal ${terminalName} exited with code ${exitCode}`);
                resolve(exitCode);
            });

            try {
                terminal.start();
                log.debug("Terminal", `Terminal ${terminalName} started`);
            } catch (e) {
                log.error("Terminal", `Failed to start terminal ${terminalName}: ${e instanceof Error ? e.message : String(e)}`);
                reject(e);
            }
        });
    }

    public static getTerminalCount() {
        return Terminal.terminalMap.size;
    }
}

/**
 * Interactive terminal
 * Mainly used for container exec
 */
export class InteractiveTerminal extends Terminal {
    public write(input : string) {
        this.ptyProcess?.write(input);
    }

    resetCWD() {
        const cwd = process.cwd();
        this.ptyProcess?.write(`cd "${cwd}"\r`);
    }
}

/**
 * User interactive terminal that use bash or powershell with limited commands such as docker, ls, cd, dir
 */
export class MainTerminal extends InteractiveTerminal {
    constructor(server : DockgeServer, name : string) {
        let shell;

        if (os.platform() === "win32") {
            if (commandExistsSync("pwsh.exe")) {
                shell = "pwsh.exe";
            } else {
                shell = "powershell.exe";
            }
        } else {
            shell = "bash";
        }
        super(server, name, shell, [], server.stacksDir);
    }

    public write(input : string) {
        // For like Ctrl + C
        if (allowedRawKeys.includes(input)) {
            super.write(input);
            return;
        }

        // Check if the command is allowed
        const cmdParts = input.split(" ");
        const executable = cmdParts[0].trim();
        log.debug("console", "Executable: " + executable);
        log.debug("console", "Executable length: " + executable.length);

        if (!allowedCommandList.includes(executable)) {
            throw new Error("Command not allowed.");
        }
        super.write(input);
    }
}
