import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import which from 'which';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import * as tar from 'tar';
import * as yauzl from 'yauzl';

let client: LanguageClient;

interface GithubRelease {
	version: string;
	assets: {
		name: string;
		browser_download_url: string;
	}[];
}

function isNewerVersion(latestVersion: string, currentVersion: string): boolean {
	// Remove 'v' prefix if present
	const latest = latestVersion.replace(/^v/, '');
	const current = currentVersion.replace(/^v/, '');
	
	const latestParts = latest.split('.').map(Number);
	const currentParts = current.split('.').map(Number);
	
	// Pad arrays to same length
	const maxLength = Math.max(latestParts.length, currentParts.length);
	while (latestParts.length < maxLength) latestParts.push(0);
	while (currentParts.length < maxLength) currentParts.push(0);
	
	for (let i = 0; i < maxLength; i++) {
		if (latestParts[i] > currentParts[i]) return true;
		if (latestParts[i] < currentParts[i]) return false;
	}
	
	return false; // Versions are equal
}

async function cleanupOldBinaries(storagePath: string, currentVersion: string): Promise<void> {
	try {
		const entries = await fs.promises.readdir(storagePath, { withFileTypes: true });
		const versionDirs = entries.filter(entry => 
			entry.isDirectory() && 
			entry.name.startsWith('iwe-') && 
			entry.name !== `iwe-${currentVersion}`
		);
		
		// Keep only the current version, remove others
		for (const dir of versionDirs) {
			const dirPath = path.join(storagePath, dir.name);
			await fs.promises.rm(dirPath, { recursive: true, force: true });
		}
	} catch (error) {
		// Ignore cleanup errors
		console.warn('Failed to cleanup old binaries:', error);
	}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	// Check for extension version-based updates
	await checkForExtensionUpdate(context);
	
	// Initialize language server
	await activateLanguageServer(context);
	
	// Register manual update command
	const updateCommand = vscode.commands.registerCommand('iwe.updateLanguageServer', async () => {
		const result = await vscode.window.showWarningMessage(
			'This will update the IWE language server to the latest version. Continue?',
			'Update',
			'Cancel'
		);
		
		if (result === 'Update') {
			try {
				// Force update by clearing cache
				await context.globalState.update('iweBinaryPath', undefined);
				await context.globalState.update('iweBinaryVersion', undefined);
				await context.globalState.update('lastUpdateCheck', 0);
				
				// Restart language server with new binary
				if (client) {
					await client.stop();
				}
				await activateLanguageServer(context);
				
				vscode.window.showInformationMessage('IWE language server updated successfully!');
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to update language server: ${(error as Error).message}`);
			}
		}
	});
	
	context.subscriptions.push(updateCommand);
}

async function checkForExtensionUpdate(context: vscode.ExtensionContext): Promise<void> {
	const currentExtensionVersion = context.extension.packageJSON.version;
	const lastExtensionVersion = context.globalState.get<string>('lastExtensionVersion');
	
	if (lastExtensionVersion !== currentExtensionVersion) {
		// Extension was updated, refresh binary
		await context.globalState.update('iweBinaryPath', undefined);
		await context.globalState.update('iweBinaryVersion', undefined);
		await context.globalState.update('lastUpdateCheck', 0);
		await context.globalState.update('lastExtensionVersion', currentExtensionVersion);
	}
}

async function activateLanguageServer(context: vscode.ExtensionContext): Promise<void> {
	const serverPath = await getLanguageServerBinary(context.globalStorageUri.fsPath, context);
	if (!serverPath) {
		vscode.window.showErrorMessage('Failed to initialize IWE language server');
		return;
	}

	// Create the language client and start it
	const serverOptions: ServerOptions = {
		command: serverPath,
		args: ['']
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'markdown' }],
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*.md')
		}
	};

	client = new LanguageClient(
		'iweLanguageServer',
		'IWE Language Server',
		serverOptions,
		clientOptions
	);

	// Start the client
	await client.start();
}

async function getLanguageServerBinary(storagePath: string, context: vscode.ExtensionContext): Promise<string | undefined> {
	const config = vscode.workspace.getConfiguration('iwe');
	const autoUpdate = config.get<boolean>('autoUpdate', true);
	const updateCheckInterval = config.get<number>('updateCheckInterval', 24);
	
	const cachedPath = context.globalState.get<string>('iweBinaryPath');
	const cachedVersion = context.globalState.get<string>('iweBinaryVersion');
	const lastUpdateCheck = context.globalState.get<number>('lastUpdateCheck', 0);
	
	const binaryName = os.platform() === 'win32' ? 'iwes.exe' : 'iwes';
	
	// Check for updates if auto-update is enabled and interval has passed
	const shouldCheckForUpdates = autoUpdate && (Date.now() - lastUpdateCheck > updateCheckInterval * 60 * 60 * 1000);
	
	// If we have a cached binary and shouldn't check for updates, use it
	if (cachedPath && fs.existsSync(cachedPath) && !shouldCheckForUpdates) {
		return cachedPath;
	}

	try {
		// Check if 'iwes' is available in PATH (developer mode)
		const iwesInPath = await which(binaryName, { nothrow: true });
		if (iwesInPath) {
			await context.globalState.update('iweBinaryPath', iwesInPath);
			await context.globalState.update('lastUpdateCheck', Date.now());
			return iwesInPath;
		}

		// Fetch latest release information
		const release = await getLatestGithubRelease();
		await context.globalState.update('lastUpdateCheck', Date.now());
		
		// Check if we have a newer version available
		const needsUpdate = !cachedVersion || isNewerVersion(release.version, cachedVersion);
		
		// If we have a cached binary and it's up to date, use it
		if (cachedPath && fs.existsSync(cachedPath) && !needsUpdate) {
			return cachedPath;
		}
		
		// Download new version if needed
		if (needsUpdate) {
			const assetName = getAssetNameForPlatform(release.version);
			const asset = release.assets.find(a => a.name === assetName);
			if (!asset) {
				throw new Error(`No matching asset found for platform: ${assetName}`);
			}

			const versionDir = path.join(storagePath, `iwe-${release.version}`);
			fs.mkdirSync(versionDir, { recursive: true });

			const binaryPath = path.join(versionDir, binaryName);
			await downloadAndExtractBinary(asset.browser_download_url, binaryPath);

			await context.globalState.update('iweBinaryPath', binaryPath);
			await context.globalState.update('iweBinaryVersion', release.version);
			
			// Clean up old versions
			await cleanupOldBinaries(storagePath, release.version);
			
			// Show update notification if this was an automatic update
			if (cachedVersion && shouldCheckForUpdates) {
				vscode.window.showInformationMessage(
					`IWE language server updated to ${release.version}`,
					'Show Release Notes'
				).then(result => {
					if (result === 'Show Release Notes') {
						vscode.env.openExternal(vscode.Uri.parse(`https://github.com/iwe-org/iwe/releases/tag/${release.version}`));
					}
				});
			}
			
			return binaryPath;
		}
		
		// Fallback to cached version
		return cachedPath;
		
	} catch (error) {
		// If we have a cached binary, fall back to it on network errors
		if (cachedPath && fs.existsSync(cachedPath)) {
			console.warn('Failed to check for updates, using cached binary:', error);
			return cachedPath;
		}
		
		vscode.window.showErrorMessage(`Failed to initialize IWE server: ${(error as Error).message}`);
		return undefined;
	}
}

async function getLatestGithubRelease(): Promise<GithubRelease> {
	const options = {
		hostname: 'api.github.com',
		path: '/repos/iwe-org/iwe/releases/latest',
		headers: {
			'User-Agent': 'VS Code IWE Extension'
		}
	};

	return new Promise((resolve, reject) => {
		https.get(options, (res) => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				const response = JSON.parse(data);
				// Transform the GitHub API response to match our interface
				const release: GithubRelease = {
					version: response.tag_name,
					assets: response.assets.map((asset: any) => ({
						name: asset.name,
						browser_download_url: asset.browser_download_url
					}))
				};
				resolve(release);
			});
			res.on('error', reject);
		}).on('error', reject);
	});
}

async function downloadAndExtractBinary(url: string, destPath: string): Promise<void> {
	const tmpDir = path.join(path.dirname(destPath), 'tmp');
	const isWindows = os.platform() === 'win32';
	const archivePath = path.join(tmpDir, isWindows ? 'release.zip' : 'release.tar.gz');
	
	await fs.promises.mkdir(tmpDir, { recursive: true });
	
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(archivePath);
		const downloadFile = (downloadUrl: string) => {
			return https.get(downloadUrl, (res) => {
				if (res.statusCode === 302 || res.statusCode === 301) {
					const redirectUrl = res.headers.location;
					if (!redirectUrl) {
						reject(new Error('Redirect location header missing'));
						return;
					}
					downloadFile(redirectUrl);
					return;
				}

				if (res.statusCode !== 200) {
					reject(new Error(`Server returned status code ${res.statusCode}`));
					return;
				}

				res.pipe(file);

				file.on('finish', async () => {
					file.close();
					try {
						if (isWindows) {
							await extractZip(archivePath, tmpDir);
						} else {
							await tar.x({
								file: archivePath,
								cwd: tmpDir
							});
						}

						// Find and move the binary
						const files = await fs.promises.readdir(tmpDir);
						const binaryName = isWindows ? 'iwes.exe' : 'iwes';
						const binary = files.find(f => f === binaryName || f.endsWith(`/${binaryName}`));
						if (!binary) {
							throw new Error('Binary not found in archive');
						}

						await fs.promises.rename(path.join(tmpDir, binary), destPath);
						if (!isWindows) {
							await fs.promises.chmod(destPath, '755');
						}

						// Cleanup
						await fs.promises.rm(tmpDir, { recursive: true, force: true });
						resolve();
					} catch (err) {
						reject(err);
					}
				});
			}).on('error', reject);
		};

		downloadFile(url);
	});
}

function extractZip(zipPath: string, destPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
			if (err) { reject(err); return; }
			if (!zipfile) { reject(new Error('Failed to open zip file')); return; }

			zipfile.on('error', reject);
			zipfile.on('end', resolve);

			zipfile.on('entry', (entry) => {
				if (/\/$/.test(entry.fileName)) {
					zipfile.readEntry(); // Skip directories
					return;
				}

				zipfile.openReadStream(entry, (err, readStream) => {
					if (err) { reject(err); return; }
					if (!readStream) { reject(new Error('Failed to open read stream')); return; }

					const outputPath = path.join(destPath, entry.fileName);
					const outputDir = path.dirname(outputPath);

					fs.promises.mkdir(outputDir, { recursive: true })
						.then(() => {
							const writeStream = fs.createWriteStream(outputPath);
							readStream.pipe(writeStream);
							writeStream.on('finish', () => {
								zipfile.readEntry();
							});
						})
						.catch(reject);
				});
			});

			zipfile.readEntry();
		});
	});
}

function getAssetNameForPlatform(version: string): string {
	const platform = os.platform();
	const arch = os.arch();

	switch (platform) {
		case 'linux':
			return `${version}-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu.tar.gz`;
		case 'darwin':
			return `${version}-universal-apple-darwin.tar.gz`;
		case 'win32':
			return `${version}-x86_64-pc-windows-msvc.zip`;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}
}

// This method is called when your extension is deactivated
export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
