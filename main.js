const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');

// Arkada Express sunucusunu otomatik başlatır
require('./server.js');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false, // Özel Discord tarzı üst bar için
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
});

ipcMain.on('window-minimize', (e) => BrowserWindow.getFocusedWindow().minimize());
ipcMain.on('window-close', (e) => BrowserWindow.getFocusedWindow().close());

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
  return sources;
});