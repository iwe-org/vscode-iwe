import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import which from 'which';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import * as tar from 'tar';

let client: LanguageClient;

interface GithubRelease {
	version: string;
	assets: {
		name: string;
		browser_download_url: string;
	}[];
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
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
	// Check if we already have a valid binary
	const cachedPath = context.globalState.get<string>('iweBinaryPath');
	if (cachedPath && fs.existsSync(cachedPath)) {
		return cachedPath;
	}

	try {
		// Check if 'iwes' is available in PATH
		const iwesInPath = await which('iwes', { nothrow: true });
		if (iwesInPath) {
			await context.globalState.update('iweBinaryPath', iwesInPath);
			return iwesInPath;
		}

		// Download from GitHub
		const release = await getLatestGithubRelease();
		const assetName = getAssetNameForPlatform(release.version);
		const asset = release.assets.find(a => a.name === assetName);
		if (!asset) {
			throw new Error(`No matching asset found for platform: ${assetName}`);
		}

		const versionDir = path.join(storagePath, `iwe-${release.version}`);
		fs.mkdirSync(versionDir, { recursive: true });

		const binaryPath = path.join(versionDir, 'iwes');
		await downloadAndExtractBinary(asset.browser_download_url, binaryPath);

		await context.globalState.update('iweBinaryPath', binaryPath);
		return binaryPath;
	} catch (error) {
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
	const archivePath = path.join(tmpDir, 'release.tar.gz');
	
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
						// Extract the tar.gz file
						await tar.x({
							file: archivePath,
							cwd: tmpDir
						});

						// Find and move the binary
						const files = await fs.promises.readdir(tmpDir);
						const binary = files.find(f => f === 'iwes' || f.endsWith('/iwes'));
						if (!binary) {
							throw new Error('Binary not found in archive');
						}

						await fs.promises.rename(path.join(tmpDir, binary), destPath);
						await fs.promises.chmod(destPath, '755');

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

function getAssetNameForPlatform(version: string): string {
	const platform = os.platform();
	const arch = os.arch();

	switch (platform) {
		case 'linux':
			return `${version}-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu.tar.gz`;
		case 'darwin':
			return `${version}-universal-apple-darwin.tar.gz`;
		case 'win32':
			throw new Error('Windows is not supported at the moment');
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
