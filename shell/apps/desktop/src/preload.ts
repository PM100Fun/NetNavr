import { contextBridge, ipcRenderer } from "electron";

import {
  parseShellConnectionInfo,
  SHELL_CONNECTION_CHANNEL,
} from "./security.js";

const connection = ipcRenderer
  .invoke(SHELL_CONNECTION_CHANNEL)
  .then(parseShellConnectionInfo);

contextBridge.exposeInMainWorld(
  "netnavr",
  Object.freeze({
    getShellConnection: async () => {
      const resolved = await connection;
      return { ...resolved };
    },
  }),
);
