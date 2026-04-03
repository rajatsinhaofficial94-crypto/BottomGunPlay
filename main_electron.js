const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Basic crash reporter
process.on('uncaughtException', (error) => {
    const logPath = path.join(app.getPath('desktop'), 'BottomGun2_CrashLog.txt');
    fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] Uncaught Exception:\n${error.stack}\n`);
    dialog.showErrorBox('Fatal Error', `An error occurred. Check ${logPath} for details.\n\n${error.message}`);
});

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
        // fullscreen: true // Optional: game feel
    });

    try {
        mainWindow.loadFile(path.join(__dirname, 'index.html'));
        mainWindow.maximize();
    } catch(err) {
        const logPath = path.join(app.getPath('desktop'), 'BottomGun2_CrashLog.txt');
        fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] Load Error:\n${err.stack}\n`);
        dialog.showErrorBox('Load Error', `Failed to load index.html. Check log.`);
    }
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
