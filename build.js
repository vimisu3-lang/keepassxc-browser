#!/usr/bin/env node
'use strict';

const fs = require('@npmcli/fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const DEST = 'keepassxc-browser';
const MANIFEST = `${DEST}/manifest.json`;
const DEFAULT = 'manifest_default.json';

const getVersion = async () => {
    const manifestFile = await fs.readFile(MANIFEST, { encoding: 'utf8' });
    const data = JSON.parse(manifestFile);
    return data['version'];
};

(async() => {
    // Preserve the source manifest for later runs (keepassxc-browser/manifest.json is
    // the single source of truth for Chromium builds)
    await fs.copyFile(MANIFEST, `./${DEFAULT}`);
    const version = await getVersion();

    console.log(`PWSave: Creating Chromium extension package`);
    const fileName = `pwsave_${version}_Chromium.zip`;
    if (await fs.exists(fileName)) {
        await fs.rm(fileName);
    }

    await createZipFile(fileName, DEST);
    console.log('Done');
})();

const createZipFile = async (fileName, path) => {
    await exec(`cd ${path} && tar -a -cf ../${fileName} * && cd ..`);
};