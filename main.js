const path = require('path');
const fs = require('fs');
const axios = require('axios').default;
const sha1File = require("sha1-file");
const dirTree = require("directory-tree");
const chokidar = require('chokidar');
const FormData = require('form-data');
const querystring = require('querystring');

const { autoUpdater } = require('electron-updater');

const {
    app,
    BrowserWindow,
    Menu,
    Tray,
    nativeImage,
    dialog,
    shell,
} = require('electron');


const version = "v1.0.3";


const DOCUMENTS_ROOT = app.getPath("documents");

let CONFIG = {
    name: null,
    token: null,
};

//const console = { log: function () { } };

const OWN_FILES_NAME = "Saját mappa";
const PROJECT_FILES_NAME = "Projektek";
const SHARED_FILES_NAME = "Velem megosztva";

let TREE = null;
let SYNC = true;

function getFolderIdFromLocalPath(localPath) {
    if (!TREE) {
        return null;
    }
    localPath = localPath.replace(/\\/g, "/");
    localPath = localPath.replace(/^\//g, "");
    localPath = localPath.replace(/\/$/g, "");
    const parts = localPath.split("/");

    if (parts.length <= 1) {
        return null;
    }
    const firstLevel = parts[0];
    if (firstLevel === OWN_FILES_NAME) {
        parts.shift();
        return {
            dir_id: TREE.own_dir_id,
            path: parts.join("/"),
        };
    }
    if (firstLevel === PROJECT_FILES_NAME) {
        parts.shift();
        const secondLevel = parts[0];
        if (!secondLevel) {
            return null;
        }
        let foundProjectId = null;
        let foundProjectName = null;
        TREE.projects.forEach(function (item) {
            if (item.name === secondLevel) {
                foundProjectId = item.folder_id;
                foundProjectName = item.name;
            }
        });
        if (!foundProjectId) {
            return null;
        }
        parts.shift();
        return {
            dir_id: foundProjectId,
            path: parts.join("/"),
        };
    }
    if (firstLevel === SHARED_FILES_NAME) {
        parts.shift();
        const secondLevel = parts[0];
        if (!secondLevel) {
            return null;
        }
        let foundSharedId = null;
        let foundSharedName = null;
        TREE.shared.forEach(function (item) {
            if (item.name === secondLevel) {
                foundSharedId = item.id;
                foundSharedName = item.name;
            }
        });
        if (!foundSharedId) {
            return null;
        }
        parts.shift();
        return {
            dir_id: foundSharedId,
            path: parts.join("/"),
        };
    }
    return null;
}

function login(callback) {
    try {
        const userdata = fs.readFileSync(path.join(DOCUMENTS_ROOT, 'jelszo.txt'), 'utf8');
        const splitted = userdata.split(":");
        const username = splitted[0] || "";
        const password = splitted[1] || "";
        axios({
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            data: querystring.stringify({ username, password }),
            url: 'https://cloud.euroadvance.hu/api/login',
        }).then(function (body) {
            callback(body.data.session);
        }).catch(function () {
            callback(null);
        });
    } catch (e) {
        callback(null);
    }
}

function openConfigFile(callback) {
    const p = path.join(createRootDir(), "beallitasok.json");
    if (!fs.existsSync(p)) {
        callback(null);
        return;
    }
    try {
        const config = JSON.parse(String(fs.readFileSync(p)));
        axios({
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            data: querystring.stringify({ token: config.token || '' }),
            url: 'https://cloud.euroadvance.hu/api/sync-tree',
        }).then(function (body) {
            let response;
            try {
                response = JSON.parse(body.data);
            } catch (ignore) {
                callback(null);
                return;
            }
            if (response.own_dir) {
                callback(config);
            } else {
                callback(null);
            }
        }).catch(function () {
            callback(null);
        });
    } catch (ignore) {
        callback(null);
    }
}

function createDir(path) {
    if (!fs.existsSync(path)) {
        fs.mkdirSync(path, {
            recursive: true
        });
    }
}

function createRootDir() {
    const root = DOCUMENTS_ROOT;
    const p = path.join(root, "ea-cloud");
    createDir(p);
    return p;
}

function overwriteConfigFile() {
    const p = path.join(createRootDir(), "beallitasok.json");
    fs.writeFileSync(p, JSON.stringify(CONFIG));
}

function syncConfigFile(data) {
    const p = path.join(createRootDir(), "beallitasok.json");
    const json = JSON.stringify(data, null, 4);
    if (!fs.existsSync(p)) {
        fs.writeFileSync(p, json, 'utf8');
    } else {
        try {
            const jsonData = JSON.parse(fs.readFileSync(p, 'utf8'));
            CONFIG = jsonData;
        } catch (e) {
            CONFIG = {
                name: null,
                token: null,
            };
        }
    }
}

function createOwnDir(paths) {
    const p = path.join(createRootDir(), OWN_FILES_NAME, ...paths);
    if (!fs.existsSync(p)) {
        fs.mkdirSync(p, {
            recursive: true
        });
    }
    return p;
}

function createProjectDir(paths, projectName) {
    const p = path.join(createRootDir(), PROJECT_FILES_NAME, projectName || "", ...paths);
    if (!fs.existsSync(p)) {
        fs.mkdirSync(p, {
            recursive: true
        });
    }
    return p;
}

function createSharedDir(paths, sharedDirName) {
    const root = DOCUMENTS_ROOT;
    const p = path.join(createRootDir(), SHARED_FILES_NAME, sharedDirName || "", ...paths);
    if (!fs.existsSync(p)) {
        fs.mkdirSync(p, {
            recursive: true
        });
    }
    return p;
}

function uploadFile(token, folder_id, p, filePath, callback) {
    const filename = path.basename(filePath);
    if (filename.startsWith("~$")) {
        console.log(`Ideiglenes fájl kihagyása: ${filename}`);
        callback(true, filename);
        return;
    }
    const formData = new FormData();
    formData.append('filename', filename);
    formData.append('token', token);
    formData.append('folder_id', String(folder_id));
    formData.append('path', p);
    formData.append('data', fs.readFileSync(filePath), filename);
    axios({
        method: 'POST',
        url: 'https://cloud.euroadvance.hu/api/sync-upload',
        headers: formData.getHeaders(),
        data: formData.getBuffer(),
    }).then(function (body) {
        try {
            const response = body.data;
            if (response.sha1) {
                console.log(`"${filename}" FELTÖLTVE.`);
                callback(true, formData.filename);
            } else {
                callback(null);
            }
        } catch (e) {
            callback(null);
        }
    }).catch(function (e) {
        callback(null);
    });
}

function downloadFile(token, sha1, path, filename, callback) {
    axios({
        method: 'GET',
        url: 'https://cloud.euroadvance.hu/api/sync-download?token=' + token + "&sha1=" + sha1,
        responseType: 'blob',
        transformResponse: [],
    }).then(function (response) {
        try {
            fs.writeFileSync(path, response.data);
            console.log(`"${filename}" LETÖLTVE.`);
            callback(true, filename);
        } catch (e) {
            console.log(e);
            console.log(`"Hiba a(z) ${filename}" fájl mentésekor.`);
            callback(null);
        }
        /*
        response.data.pipe(fs.createWriteStream(path))
            .on('close', function () {
                console.log(`"${filename}" LETÖLTVE.`);
                callback(true);
            }).on('error', function () {

                callback(null);
            });
         */
    }).catch(function () {
        console.log(`"${filename}" letöltése nem sikerült.`);
        callback(false);
    });
}

function deleteFile(token, folder_id, p, callback) {
    axios({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: querystring.stringify({ token, folder_id, path: p }),
        url: 'https://cloud.euroadvance.hu/api/sync-delete',
    }).then(function (body) {
        console.log(body.data)
        try {
            const response = body.data;
            if (response.done) {
                console.log(`"${p}" TÖRÖLVE [cloud].`);
                callback(true, p);
            } else {
                callback(null);
            }
        } catch (e) {
            callback(null);
        }
    }).catch(function () {
        console.log(`"${filename}" törlése a szerverről nem sikerült.`);
        callback(null);
    });
}

function folderTree(root, path) {
    path = path || [];
    const tree = dirTree(root, { attributes: ['mtime'] });
    const results = [];
    (tree.children || []).forEach(function (node) {
        if (node.type === "directory") {
            results.push({
                type: "dir",
                name: node.name,
                path: path,
            });
            folderTree(node.path, path.concat([ node.name ])).forEach(function (item) {
                results.push(item);
            });
        } else {
            // File
            const sha1 = sha1File.sync(node.path);
            results.push({
                type: "file",
                name: node.name,
                path: path,
                size: node.size,
                date: Math.floor(node.mtime.getTime() / 1000),
                hash: sha1,
            });
        }
    });
    return results;
}

function fetchTree(token, callback) {
    axios({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        data: querystring.stringify({ token }),
        url: 'https://cloud.euroadvance.hu/api/sync-tree',
    }).then(function (body) {
        if (body.data.own_dir) {
            TREE = body.data;
            callback(body.data);
        } else {
            callback(null);
        }
    }).catch(function () {

    });
}

function findFileInArray(array, item) {
    const id = item.path.join("/") + "/" + item.name;
    for (let item2 of array) {
        const id2 = item2.path.join("/") + "/" + item2.name;
        if (id === id2) {
            return item2;
        }
    }
}

function getFilesOnlyLocal(local, cloud) {
    const array = [];
    local.forEach(function (item) {
        const found = findFileInArray(cloud, item);
        if (!found) {
            array.push(item);
        }
    });
    return array.filter(function (item) {
        return item.type !== "dir";
    });
}

function getFilesOnlyCloud(local, cloud) {
    const array = [];
    cloud.forEach(function (item) {
        const found = findFileInArray(local, item);
        if (!found) {
            array.push(item);
        }
    });
    return array.filter(function (item) {
        return item.type !== "dir";
    });
}

function getCommonFiles(local, cloud) {
    const array = [];
    local.forEach(function (item) {
        const found = findFileInArray(cloud, item);
        if (found) {
            item.date_local = item.date;
            item.hash_local = item.hash;
            item.date_cloud = found.date;
            item.hash_cloud = found.hash;
            array.push(item);
        }
    });
    cloud.forEach(function (item) {
        let found = findFileInArray(array, item);
        if (!found) {
            found = findFileInArray(local, item);
            if (found) {
                item.date_local = found.date;
                item.hash_local = found.hash;
                item.date_cloud = item.date;
                item.hash_cloud = item.hash;
                array.push(item);
            }
        }
    });
    return array.filter(function (item) {
        return item.type !== "dir";
    });
}

function getDirsToSync(eu_cloud_dir_data) {
    const result = [];
    // Own dir
    result.push({
        title: 'Saját mappa',
        subdir: "",
        cloudDirId: eu_cloud_dir_data.own_dir_id,
        cloudDirContent: eu_cloud_dir_data.own_dir,
        dirCreator: createOwnDir,
    });
    // Project dirs
    eu_cloud_dir_data.projects.forEach(function (item) {
        result.push({
            title: 'Projekt mappa: ' + item.name,
            subdir: item.name,
            cloudDirId: item.folder_id,
            cloudDirContent: item.content,
            dirCreator: createProjectDir,
        });
    });

    // Shared dirs

    eu_cloud_dir_data.shared.forEach(function (item) {
        result.push({
            title: 'Megosztott mappa: ' + item.name,
            cloudDirId: item.id,
            subdir: item.name,
            cloudDirContent: item.content,
            dirCreator: createSharedDir,
        });
    });

    return result;
}

function syncAllDir(token, callback, canDelete) {
    fetchTree(token, function (eu_cloud_dir_data) {
        if (!eu_cloud_dir_data) {
            callback(null);
            return;
        }

        const dirsToSync = getDirsToSync(eu_cloud_dir_data);

        (function nextRootDirectory() {
            const dirToSync = dirsToSync.shift();
            if (dirToSync) {
                const cloudDirId = dirToSync.cloudDirId;
                const cloudDirContent = dirToSync.cloudDirContent;
                const dirCreator = dirToSync.dirCreator;

                const localDirRoot = dirCreator([], dirToSync.subdir);
                const localDirContent = folderTree(localDirRoot);

                (function () {

                    const localFiles = getFilesOnlyLocal(localDirContent, cloudDirContent);
                    const cloudFiles = getFilesOnlyCloud(localDirContent, cloudDirContent);
                    const commonFiles = getCommonFiles(localDirContent, cloudDirContent);

                    (function downloadNext() {
                        const item = cloudFiles.pop();
                        if (item) {
                            downloadFile(
                                token,
                                item.hash,
                                path.join(dirCreator(item.path, dirToSync.subdir), item.name),
                                item.name,
                                function (success, filename) {
                                    downloadNext();
                                }
                            );
                        } else {
                            (function uploadNext() {
                                const item = localFiles.pop();
                                if (item) {
                                    if (canDelete) {
                                        if (!item.name.startsWith("~$")) {
                                            const localPath = path.join(dirCreator(item.path, dirToSync.subdir), item.name);
                                            const localTime = fs.statSync(localPath).mtime;
                                            if (Date.now() >= 1000 * 60 + localTime) {
                                                fs.unlinkSync(localPath);
                                                console.log(`${item.name} TÖRÖLVE [local].`);
                                            }
                                        }
                                        uploadNext();
                                    } else {
                                        uploadFile(
                                            token,
                                            cloudDirId,
                                            item.path.join("/"),
                                            path.join(dirCreator(item.path, dirToSync.subdir), item.name),
                                            function (success, filename) {
                                                uploadNext();
                                            }
                                        );
                                    }
                                } else {
                                    (function compareCommonFile() {
                                        const item = commonFiles.pop();
                                        if (item) {
                                            if (item.hash_local !== item.hash_cloud) {
                                                // console.log(item);
                                                /*
                                                let localFileSize = 0;
                                                try {
                                                    localFileSize = fs.statSync(path.join(dirCreator(item.path, dirToSync.subdir), item.name)).size;
                                                } catch (e) { }
                                                */
                                                if (item.date_local < item.date_cloud) {
                                                    // Cloud is newer
                                                    if (!canDelete) {
                                                        downloadFile(
                                                            token,
                                                            item.hash_cloud,
                                                            path.join(dirCreator(item.path, dirToSync.subdir), item.name),
                                                            item.name,
                                                            function (success, filename) {
                                                                compareCommonFile();
                                                            }
                                                        );
                                                    } else {

                                                    }
                                                } else if (item.date_local > item.date_cloud) {
                                                    // Local is newer
                                                    if (!canDelete) {
                                                        uploadFile(
                                                            token,
                                                            cloudDirId,
                                                            item.path.join("/"),
                                                            path.join(dirCreator(item.path, dirToSync.subdir), item.name),
                                                            function (success, filename) {
                                                                compareCommonFile();
                                                            }
                                                        );
                                                    } else {
                                                        compareCommonFile();
                                                    }
                                                } else {
                                                    // Dates are equal
                                                    compareCommonFile();
                                                }
                                            } else {
                                                // Hashes are equal
                                                compareCommonFile();
                                            }
                                        } else {
                                            nextRootDirectory();
                                        }
                                    }());
                                }
                            }());
                        }
                    }());
                }());
            } else {
                callback();
            }
        }());
    });
}


let firstCycle = true;
function startSync() {

    syncAllDir(CONFIG.token, function itself() {
        console.log("== Auto-sync started ==");

        const rootDir = createRootDir();

        if (firstCycle) {
            let choki = chokidar.watch(rootDir, {
                awaitWriteFinish: true,
                ignorePermissionErrors: true,
                ignoreInitial: true,
            }).on('all', (event, path) => {
                console.log("change");

                const relativePath = path
                    .replace(rootDir, "")
                    .replace(/\\/g, "/")
                    .replace(/^\//g, "");

                const fileInfo = getFolderIdFromLocalPath(relativePath)
                if (fileInfo) {
                    if (event === "unlink" || event === "unlinkDir") {
                        deleteFile(CONFIG.token, fileInfo.dir_id, fileInfo.path, function () {
                        });
                    }
                    if (event === "add" || event === "change") {

                        const pathParts = fileInfo.path.split("/");
                        pathParts.pop(); // pop the filename
                        uploadFile(CONFIG.token, fileInfo.dir_id, pathParts.join("/"), path, function () {

                        });

                    }
                }
            }).on("error", function (e) {

            });
        }

        if (SYNC) {
            setTimeout(function () {
                syncAllDir(CONFIG.token, itself, true);
            }, 3000);
        }

        firstCycle = false;
    });
}

/* ============== UI ================ */



let mainWindow = null;
let tray = null;
let appIcon = nativeImage.createFromPath(path.join(__dirname, "assets/icon.ico"));

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 640,
        height: 480,
        icon: appIcon,
        resizable: false,
    });
    mainWindow.setMenu(null);
    mainWindow.loadFile('index.html');
    mainWindow.webContents.on("console-message", function (e, level, message) {
        try {
            const session = JSON.parse(message);
            mainWindow.close();
            mainWindow = null;
            CONFIG.name = session.name;
            CONFIG.token = session.token;
            tray.setContextMenu(createLoggedInContextMenu());
            overwriteConfigFile();
            startSync();
        } catch (ignore) {

        }
    })
}

function logout() {
    CONFIG.name = null;
    CONFIG.token = null;
    tray.setContextMenu(createDefaultContextMenu());
    const p = path.join(createRootDir(), "beallitasok.json");
    fs.unlinkSync(p);
    SYNC = false;
}

function createDefaultContextMenu() {
    return Menu.buildFromTemplate([
        { label: 'Bejelentkezés', type: 'normal', click: function () { createMainWindow(); }},
        { type: 'separator' },
        { label: 'Program bezárása', type: 'normal', click: function () { app.quit() } },
        { type: 'separator' },
        { label: 'Verzió: ' + version, type: 'normal', enabled: false },
    ]);
}

function createLoggedInContextMenu() {
    return Menu.buildFromTemplate([
        { label: '' + CONFIG.name, type: 'normal', enabled: false },
        { label: 'Kijelentkezés ', type: 'normal', click: function () {
                logout();
            } },
        { type: 'separator' },
        { label: 'Saját mappa megnyitása', type: 'normal', click: function () { shell.openPath(createOwnDir([])); }},
        { label: 'Projektek mappa megnyitása', type: 'normal', click: function () { shell.openPath(createProjectDir([])); }},
        { label: 'Velem megosztottak megnyitása', type: 'normal', click: function () { shell.openPath(createSharedDir([])); }},

        { type: 'separator' },
        { label: 'Szinkronizálás: be', type: 'radio', checked: SYNC, click: function () {
            if (!SYNC) {
                startSync();
            }
            SYNC = true;
        } },
        { label: 'Szinkronizálás: ki', type: 'radio', checked: !SYNC, click: function () {
            SYNC = false;
        } },
        { type: 'separator' },
        { label: 'Program bezárása', type: 'normal', click: function () { app.quit() } },
        { type: 'separator' },
        { label: 'Verzió: ' + version, type: 'normal', enabled: false },
    ]);
}

app.whenReady().then(() => {
    tray = new Tray(appIcon);

    tray.focus();

    tray.setToolTip('EA Cloud');
    tray.setContextMenu(CONFIG.token ? createLoggedInContextMenu() : createDefaultContextMenu());

    tray.on('click', function () {
        if (!CONFIG.token && (!mainWindow || mainWindow.isDestroyed())) {
            createMainWindow();
        }
    });

    if (!CONFIG.token) {
        createMainWindow();
    }
});


app.on('window-all-closed', function (e) {
    e.preventDefault();
});

syncConfigFile(CONFIG);
if (CONFIG.token) {
    startSync();
}

// Single instance
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
    app.quit()
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
    });
}

autoUpdater.on('update-available', () => {
    dialog.showMessageBoxSync({ message: "Új frissítés érhető el." });
});
autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBoxSync({ message: "A frissítés sikeresen letöltve." });
});