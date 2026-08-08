import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, Menu, shell } from "electron";
import { startAgentServer, type AgentServerHandle } from "@netnavr/shell-server";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let agentServer: AgentServerHandle | null = null;

async function createWindow() {
  if (!agentServer) {
    const configuredWorkspace = process.env.NETNAVR_SHELL_WORKSPACE?.trim();
    const workspaceRoot = configuredWorkspace
      ? path.resolve(configuredWorkspace)
      : path.join(app.getPath("userData"), "workspace");

    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    agentServer = await startAgentServer({
      host: "127.0.0.1",
      port: 8787,
      workspaceRoot
    });
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "NetNavr Shell",
    backgroundColor: "#f6f7f5",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const rendererPath = path.resolve(__dirname, "../../web/dist/index.html");
  const launchParameters = new URLSearchParams({
    webSocketUrl: agentServer.webSocketUrl,
    sessionToken: agentServer.sessionToken
  });
  await mainWindow.loadFile(rendererPath, { hash: launchParameters.toString() });
}

function installMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "File",
      submenu: [{ role: "close" }]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName("NetNavr Shell");

await app.whenReady();
installMenu();
await createWindow();

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on("before-quit", async (event) => {
  if (!agentServer) return;

  event.preventDefault();
  const server = agentServer;
  agentServer = null;
  await server.close().catch((error: unknown) => {
    console.error("Failed to close agent server", error);
  });
  app.quit();
});
