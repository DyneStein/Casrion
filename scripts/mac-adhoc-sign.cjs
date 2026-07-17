// Apple Silicon refuses to launch an app with no signature at all. With no
// Apple Developer cert in CI, electron-builder skips signing entirely, so
// this afterPack hook applies an ad-hoc signature (codesign identity "-").
// Users still right-click > Open the first time (unsigned != notarized),
// but the app runs instead of being killed on launch.
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  execSync(`codesign --verify --verbose "${appPath}"`, { stdio: 'inherit' });
};
