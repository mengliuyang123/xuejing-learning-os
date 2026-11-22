const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  safeStorage,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.LEARNOS_PORT || 5173);
const HOST = "127.0.0.1";
const APP_URL = `http://${HOST}:${PORT}`;
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(PROJECT_ROOT, "data");
const SECRETS_FILE = path.join(DATA_DIR, ".secrets.enc.json");

app.setName("学径");

let mainWindow = null;
let tray = null;
let serverProcess = null;

function resolveIconPath() {
  const candidates =
    process.platform === "win32"
      ? [
          path.join(PROJECT_ROOT, "build", "icon.ico"),
          path.join(PROJECT_ROOT, "public", "icons", "xuejing.ico"),
          path.join(PROJECT_ROOT, "build", "icon.png"),
        ]
      : [
          path.join(PROJECT_ROOT, "build", "icon.png"),
          path.join(PROJECT_ROOT, "public", "icons", "xuejing-512.png"),
        ];
  return candidates.find((p) => fs.existsSync(p)) || undefined;
}

function getTitleBarOverlayStyle(theme) {
  if (theme === "dark") {
    return {
      color: "#151a24",
      symbolColor: "#e9eef7",
      height: 38,
    };
  }
  return {
    color: "#f1f5f9",
    symbolColor: "#182230",
    height: 38,
  };
}

function readEncryptedSecretsMap() {
  try {
    if (!fs.existsSync(SECRETS_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeEncryptedSecretsMap(map) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(map, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function checkServerReady(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureLocalServer() {
  const alreadyUp = await checkServerReady(APP_URL);
  if (alreadyUp) return;

  const nextBin = path.join(
    PROJECT_ROOT,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  const hasBuild = fs.existsSync(
    path.join(PROJECT_ROOT, ".next", "BUILD_ID"),
  );
  const args = hasBuild
    ? [nextBin, "start", "--hostname", HOST, "-p", String(PORT)]
    : [nextBin, "dev", "--webpack", "--hostname", HOST, "-p", String(PORT)];

  serverProcess = spawn("node", args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NODE_ENV: hasBuild ? "production" : "development" },
    stdio: "ignore",
    windowsHide: true,
  });

  for (let i = 0; i < 60; i++) {
    const ok = await checkServerReady(APP_URL);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 350));
  }
}

function ensureTray(iconPath) {
  if (tray || !iconPath) return;
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) return;
    tray = new Tray(img);
    tray.setToolTip("学径 · 个人学习工作台");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "打开学径",
          click: () => {
            if (!mainWindow) {
              void createDesktopWindow();
              return;
            }
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          },
        },
        {
          label: "打开本机数据目录",
          click: () => {
            if (!fs.existsSync(DATA_DIR)) {
              fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            void shell.openPath(DATA_DIR);
          },
        },
        { type: "separator" },
        {
          label: "退出学径",
          click: () => app.quit(),
        },
      ]),
    );
    tray.on("click", () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  } catch {
    // Tray creation is best-effort on unsupported desktop environments
  }
}

async function createDesktopWindow() {
  await ensureLocalServer();
  const iconPath = resolveIconPath();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1020,
    minHeight: 660,
    title: "学径",
    icon: iconPath,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: getTitleBarOverlayStyle("light"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ensureTray(iconPath);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  await mainWindow.loadURL(APP_URL);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("desktop:open-data-dir", async () => {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  await shell.openPath(DATA_DIR);
  return { ok: true, path: DATA_DIR };
});

ipcMain.handle("desktop:get-info", () => ({
  isDesktop: true,
  appName: "学径",
  platform: process.platform,
  electronVersion: process.versions.electron,
  nodeVersion: process.versions.node,
  safeStorageAvailable: Boolean(
    safeStorage && safeStorage.isEncryptionAvailable(),
  ),
  dataPath: path.resolve(DATA_DIR, "learnos.sqlite"),
}));

ipcMain.handle("desktop:set-theme", (_event, theme) => {
  const normalized = theme === "dark" ? "dark" : "light";
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setBackgroundColor(
        normalized === "dark" ? "#11151d" : "#ffffff",
      );
      if (typeof mainWindow.setTitleBarOverlay === "function") {
        mainWindow.setTitleBarOverlay(getTitleBarOverlayStyle(normalized));
      }
    } catch {
      // Ignore platforms without titleBarOverlay support
    }
  }
  return { ok: true, theme: normalized };
});

ipcMain.handle("desktop:secret-available", () =>
  Boolean(safeStorage && safeStorage.isEncryptionAvailable()),
);

ipcMain.handle("desktop:secret-get", (_event, key) => {
  if (
    typeof key !== "string" ||
    !key.trim() ||
    !safeStorage ||
    !safeStorage.isEncryptionAvailable()
  ) {
    return null;
  }
  try {
    const map = readEncryptedSecretsMap();
    const encoded = map[key];
    if (typeof encoded !== "string" || !encoded) return null;
    const buf = Buffer.from(encoded, "base64");
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
});

ipcMain.handle("desktop:secret-set", (_event, key, value) => {
  if (
    typeof key !== "string" ||
    !key.trim() ||
    typeof value !== "string" ||
    !safeStorage ||
    !safeStorage.isEncryptionAvailable()
  ) {
    return { ok: false };
  }
  try {
    const map = readEncryptedSecretsMap();
    const encrypted = safeStorage.encryptString(value);
    map[key] = encrypted.toString("base64");
    writeEncryptedSecretsMap(map);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("desktop:secret-delete", (_event, key) => {
  if (typeof key !== "string" || !key.trim()) return { ok: false };
  try {
    const map = readEncryptedSecretsMap();
    if (key in map) {
      delete map[key];
      writeEncryptedSecretsMap(map);
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

app.whenReady().then(() => {
  void createDesktopWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createDesktopWindow();
    }
  });
});

app.on("before-quit", () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on("window-all-closed", () => {
  if (serverProcess) {
    try {
      serverProcess.kill();
    } catch {}
    serverProcess = null;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
