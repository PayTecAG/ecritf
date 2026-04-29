const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');
const WebSocket = require('ws');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

let mainWindow;
let socket = null;
let wsClient = null;
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

// Load custom CA certificates for WSS connections
const caPath = fs.existsSync(path.join(__dirname, 'ca-certificates.pem'))
  ? path.join(__dirname, 'ca-certificates.pem')
  : fs.existsSync(path.join(process.resourcesPath || '', 'ca-certificates.pem'))
    ? path.join(process.resourcesPath, 'ca-certificates.pem')
    : null;

function loadCaCertificates() {
  if (!caPath) return undefined;
  try {
    const content = fs.readFileSync(caPath, 'utf8').trim();
    if (!content || !content.includes('-----BEGIN CERTIFICATE-----')) return undefined;
    return content;
  } catch {
    return undefined;
  }
}

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
    destroyConnection();
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
function destroyConnection() {
  if (wsClient) {
    wsClient.removeAllListeners();
    wsClient.close();
    wsClient = null;
  }
  if (socket) {
    socket.removeAllListeners();
    socket.destroy();
    socket = null;
  }
}

function setupDataStream(writeFn) {
  // Returns a function to feed incoming data through the line-buffered parser
  return (data) => {
    rxBuffer += typeof data === 'string' ? data : data.toString();
    let newlineIdx;
    while ((newlineIdx = rxBuffer.indexOf('\n')) !== -1) {
      const line = rxBuffer.substring(0, newlineIdx).trim();
      rxBuffer = rxBuffer.substring(newlineIdx + 1);
      if (line) {
        processIncoming(line);
      }
    }
  };
}

ipcMain.handle('terminal:connect', async (event, host, port, protocol) => {
  return new Promise((resolve, reject) => {
    destroyConnection();
    rxBuffer = '';

    if (protocol === 'wss') {
      const ca = loadCaCertificates();
      const wsOptions = {
        rejectUnauthorized: !!ca,
      };
      if (ca) {
        wsOptions.ca = ca;
      }

      const url = `wss://${host}:${port}`;
      wsClient = new WebSocket(url, wsOptions);

      const timeout = setTimeout(() => {
        if (wsClient) {
          wsClient.removeAllListeners();
          wsClient.close();
          wsClient = null;
        }
        reject(new Error('Connection timeout'));
      }, 10000);

      wsClient.on('open', () => {
        clearTimeout(timeout);
        resolve({ success: true });
      });

      wsClient.on('message', setupDataStream());

      wsClient.on('close', () => {
        clearTimeout(timeout);
        sendToRenderer('terminal:disconnected');
        wsClient = null;
      });

      wsClient.on('error', (err) => {
        clearTimeout(timeout);
        sendToRenderer('terminal:error', err.message);
        reject(err);
      });
    } else {
      socket = new net.Socket();

      socket.connect(parseInt(port), host, () => {
        socket.setTimeout(0);
        resolve({ success: true });
      });

      socket.on('data', setupDataStream());

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
    }
  });
});

ipcMain.handle('terminal:disconnect', async () => {
  destroyConnection();
  return { success: true };
});

ipcMain.handle('terminal:send', async (event, message) => {
  if (!socket && !wsClient) {
    throw new Error('Not connected');
  }
  
  const json = typeof message === 'string' ? JSON.parse(message) : message;
  const valid = validate(json);
  
  if (!valid) {
    console.log('Validation errors:', validate.errors);
  }
  
  const line = JSON.stringify(json) + '\n';
  if (wsClient) {
    wsClient.send(Buffer.from(line));
  } else {
    socket.write(line);
  }
  
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
      if (wsClient) wsClient.send(Buffer.from(response));
      else if (socket) socket.write(response);
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
