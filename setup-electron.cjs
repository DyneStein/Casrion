const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const url = 'https://github.com/electron/electron/releases/download/v42.5.0/electron-v42.5.0-win32-x64.zip';
const zipPath = path.join(__dirname, 'node_modules', 'electron', 'electron.zip');
const distPath = path.join(__dirname, 'node_modules', 'electron', 'dist');
const pathTxt = path.join(__dirname, 'node_modules', 'electron', 'path.txt');

console.log('Downloading Electron manually...');
const file = fs.createWriteStream(zipPath);
https.get(url, (response) => {
  if (response.statusCode === 302) {
    https.get(response.headers.location, (res) => {
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          console.log('Download complete, extracting...');
          try {
            execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${distPath}' -Force"`);
            fs.writeFileSync(pathTxt, 'electron.exe');
            console.log('Done!');
          } catch (e) {
            console.error('Failed to extract:', e.message);
          }
        });
      });
    });
  }
});
