const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PORT = Number(process.env.LEARNOS_PORT || 5173);
const HOST = "127.0.0.1";
const APP_URL = `http://${HOST}:${PORT}`;
const ROOT = path.resolve(__dirname, "..");

function checkServerReady(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureLocalServer() {
  if (await checkServerReady(APP_URL)) return null;
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  const hasBuild = fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"));
  const args = hasBuild
    ? [nextBin, "start", "--hostname", HOST, "-p", String(PORT)]
    : [nextBin, "dev", "--webpack", "--hostname", HOST, "-p", String(PORT)];

  const srv = spawn("node", args, {
    cwd: ROOT,
    stdio: "ignore",
    windowsHide: true,
  });

  for (let i = 0; i < 50; i++) {
    if (await checkServerReady(APP_URL)) return srv;
    await new Promise((r) => setTimeout(r, 300));
  }
  return srv;
}

async function main() {
  const electronExe = path.join(
    ROOT,
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron",
  );

  if (fs.existsSync(electronExe)) {
    const child = spawn(electronExe, [path.join(__dirname, "main.cjs")], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  // Instant native Windows App Window via Edge App Mode if Electron binary hasn't finished downloading
  await ensureLocalServer();
  const edgeCandidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const edgeExe = edgeCandidates.find((p) => fs.existsSync(p)) || "msedge";
  spawn(
    edgeExe,
    [`--app=${APP_URL}`, "--window-size=1440,920", "--new-window"],
    {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    },
  ).unref();
  console.log(`[学径] 已启动独立桌面应用窗口 (${APP_URL})`);
}

void main();
