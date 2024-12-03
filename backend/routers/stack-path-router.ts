import express from "express";
import { Stack } from "../stack";
import { DockgeServer } from "../dockge-server";

export const stackPathRouter = express.Router();

stackPathRouter.post("/:stackName/path", async (req, res) => {
    try {
        const stackName = req.params.stackName;
        const directoryPath = req.body.directoryPath;

        if (!directoryPath) {
            return res.status(400).json({
                message: "directoryPath is required"
            });
        }

        const stack = await Stack.getStack(req.app.get("server") as DockgeServer, stackName);
        await stack.setCustomPath(directoryPath);

        res.json({
            message: "Stack path updated successfully"
        });
    } catch (e) {
        if (e instanceof Error) {
            res.status(400).json({
                message: e.message
            });
        } else {
            res.status(500).json({
                message: "Internal server error"
            });
        }
    }
});