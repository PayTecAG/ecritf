const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

let mainWindow;
let socket = null;
let rxBuffer = '';

// Load and compile schema
// In packaged app, use extraResources; in dev, look relative to project root
const schemaPath = fs.existsSync(path.join(__dirname, 'ecritf-schema.json'))
  ? path.join(__dirname, 'ecritf-schema.json')
  : fs.existsSync(path.join(process.resourcesPath || '', 'ecritf-schema.json'))
    ? path.join(process.resourcesPath, 'ecritf-schema.json')
    : path.join(__dirname, '..', '..', '..', 'ecritf-schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

// Window state persistence
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { width: 1200, height: 850 };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const maximized = mainWindow.isMaximized();
  fs.writeFileSync(stateFile, JSON.stringify({ ...bounds, maximized }));
}

function createWindow() {
  const state = loadWindowState();
  
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 600,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'icon.png')
  });

  if (state.maximized) {
    mainWindow.maximize();
  }

  mainWindow.loadFile('index.html');
  
  // Save window state on resize/move
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  
  // Clean up socket before window closes
  mainWindow.on('close', () => {
    saveWindowState();
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
      socket = null;
    }
  });
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  
  // Uncomment for dev tools:
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  // Build application menu with version in Help
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const menuTemplate = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: `Version ${pkg.version}`,
          enabled: false
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About',
              message: pkg.description || pkg.name,
              detail: `Version: ${pkg.version}\nAuthor: ${pkg.author || ''}`,
              buttons: ['OK']
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

// Terminal connection handling
ipcMain.handle('terminal:connect', async (event, host, port) => {
  return new Promise((resolve, reject) => {
    if (socket) {
      socket.destroy();
    }
    
    rxBuffer = '';
    socket = new net.Socket();
    
    socket.connect(parseInt(port), host, () => {
      // Clear the connection timeout once connected
      socket.setTimeout(0);
      resolve({ success: true });
    });
    
    socket.on('data', (data) => {
      rxBuffer += data.toString();
      let newlineIdx;
      while ((newlineIdx = rxBuffer.indexOf('\n')) !== -1) {
        const line = rxBuffer.substring(0, newlineIdx).trim();
        rxBuffer = rxBuffer.substring(newlineIdx + 1);
        if (line) {
          processIncoming(line);
        }
      }
    });
    
    socket.on('close', () => {
      sendToRenderer('terminal:disconnected');
      socket = null;
    });
    
    socket.on('error', (err) => {
      sendToRenderer('terminal:error', err.message);
      reject(err);
    });
    
    socket.setTimeout(10000, () => {
      if (socket) socket.destroy();
      reject(new Error('Connection timeout'));
    });
  });
});

ipcMain.handle('terminal:disconnect', async () => {
  if (socket) {
    socket.destroy();
    socket = null;
  }
  return { success: true };
});

ipcMain.handle('terminal:send', async (event, message) => {
  if (!socket) {
    throw new Error('Not connected');
  }
  
  const json = typeof message === 'string' ? JSON.parse(message) : message;
  const valid = validate(json);
  
  if (!valid) {
    console.log('Validation errors:', validate.errors);
  }
  
  const line = JSON.stringify(json) + '\n';
  socket.write(line);
  
  sendToRenderer('terminal:sent', {
    message: json,
    valid,
    errors: validate.errors
  });
  
  return { success: true, valid };
});

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function processIncoming(line) {
  try {
    // Try to extract JSON from potentially framed data
    const jsonStart = line.indexOf('{');
    if (jsonStart === -1) {
      sendToRenderer('terminal:binary', line);
      return;
    }
    
    const jsonStr = line.substring(jsonStart);
    const json = JSON.parse(jsonStr);
    const valid = validate(json);
    
    // Auto-respond to HeartbeatRequest
    if (json.HeartbeatRequest !== undefined) {
      const response = JSON.stringify({ HeartbeatResponse: {} }) + '\n';
      if (socket) socket.write(response);
      sendToRenderer('terminal:heartbeat');
      return;
    }
    
    sendToRenderer('terminal:received', {
      message: json,
      valid,
      errors: validate.errors
    });
  } catch (err) {
    sendToRenderer('terminal:parseError', { line, error: err.message });
  }
}
