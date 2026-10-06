const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = 8768;
const URL = `http://127.0.0.1:${PORT}/`;
let pythonProcess = null;
let mainWindow = null;

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/status`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkServer()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function startBackend() {
  const scriptPath = path.join(__dirname, "code_agent.py");
  const pyCmd = process.platform === "win32" ? "python" : "python3";
  pythonProcess = spawn(pyCmd, [scriptPath, ".", "--port", String(PORT)], {
    cwd: __dirname,
    stdio: "inherit",
    detached: false,
  });
  pythonProcess.on("error", (err) => {
    console.error("Failed to start python backend:", err);
  });
}

async function createWindow() {
  const running = await checkServer();
  if (!running) {
    startBackend();
    const ready = await waitForServer();
    if (!ready) {
      console.warn("Backend took longer to respond; loading window anyway...");
    }
  }

  // Exact resolution from reference video: 1676 x 1400
  mainWindow = new BrowserWindow({
    width: 1676,
    height: 1400,
    minWidth: 1200,
    minHeight: 850,
    backgroundColor: "#0e1116",
    title: "CodeAtlas Studio · Architecture Map",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(URL);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (pythonProcess) {
    try {
      pythonProcess.kill();
    } catch {}
  }
  app.quit();
});
