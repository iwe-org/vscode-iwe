import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, State } from 'vscode-languageclient/node';
import {
	Release,
	RELEASE_PAGE_URL,
	fetchLatestRelease,
	findInPath,
	installRelease,
	isNewerVersion,
	removeOtherVersions,
	serverBinaryName,
} from './release';

const STATE_BINARY_PATH = 'iweBinaryPath';
const STATE_BINARY_VERSION = 'iweBinaryVersion';
const STATE_LAST_CHECK = 'lastUpdateCheck';
const STATE_EXTENSION_VERSION = 'lastExtensionVersion';
const HOUR_MS = 60 * 60 * 1000;

type BinarySource = 'setting' | 'path' | 'managed';

interface ServerBinary {
	path: string;
	source: BinarySource;
	version?: string;
}

let extensionContext: vscode.ExtensionContext;
let output: vscode.LogOutputChannel;
let statusItem: vscode.StatusBarItem;
let client: LanguageClient | undefined;
let clientDisposables: vscode.Disposable[] = [];
let currentBinary: ServerBinary | undefined;
let downloadInProgress = false;
let lifecycle: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
	const next = lifecycle.then(task);
	lifecycle = next.catch(() => undefined);
	return next;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	extensionContext = context;
	output = vscode.window.createOutputChannel('IWE', { log: true });
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusItem.name = 'IWE';
	statusItem.command = 'iwe.showOutput';
	context.subscriptions.push(output, statusItem);

	context.subscriptions.push(
		vscode.commands.registerCommand('iwe.updateLanguageServer', () => enqueue(updateLanguageServer)),
		vscode.commands.registerCommand('iwe.restartLanguageServer', () => enqueue(restartLanguageServer)),
		vscode.commands.registerCommand('iwe.showOutput', () => output.show()),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('iwe.serverPath') || event.affectsConfiguration('iwe.debug')) {
				void enqueue(restartLanguageServer);
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			if (serverWorkingDirectory() !== client?.clientOptions.workspaceFolder?.uri.fsPath) {
				void enqueue(restartLanguageServer);
			}
		}),
	);

	await resetUpdateCheckOnExtensionUpgrade(context);
	await enqueue(startLanguageServer);
}

export async function deactivate(): Promise<void> {
	await stopClient();
}

async function resetUpdateCheckOnExtensionUpgrade(context: vscode.ExtensionContext): Promise<void> {
	const version = context.extension.packageJSON.version as string;
	if (context.globalState.get<string>(STATE_EXTENSION_VERSION) !== version) {
		await context.globalState.update(STATE_LAST_CHECK, 0);
		await context.globalState.update(STATE_EXTENSION_VERSION, version);
	}
}

function setStatus(icon: string, tooltip: string): void {
	statusItem.text = `${icon} IWE`;
	statusItem.tooltip = tooltip;
	statusItem.show();
}

function describeBinary(binary: ServerBinary): string {
	const origin = binary.source === 'setting' ? 'iwe.serverPath' : binary.source === 'path' ? 'PATH' : 'managed by the extension';
	const version = binary.version ? ` ${binary.version}` : '';
	return `iwes${version} (${origin})\n${binary.path}`;
}

function serverWorkingDirectory(): string | undefined {
	const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
	const configured = folders.find(folder => fs.existsSync(path.join(folder.uri.fsPath, '.iwe', 'config.toml')));
	return (configured ?? folders[0])?.uri.fsPath;
}

function expandHome(value: string): string {
	return value === '~' || value.startsWith('~/') || value.startsWith('~\\')
		? path.join(os.homedir(), value.slice(1))
		: value;
}

function managedBinary(): ServerBinary | undefined {
	const state = extensionContext.globalState;
	const binaryPath = state.get<string>(STATE_BINARY_PATH);
	const version = state.get<string>(STATE_BINARY_VERSION);
	const storageDir = path.resolve(extensionContext.globalStorageUri.fsPath);
	if (!binaryPath || !version || !path.resolve(binaryPath).startsWith(storageDir + path.sep) || !fs.existsSync(binaryPath)) {
		return undefined;
	}
	return { path: binaryPath, source: 'managed', version };
}

async function resolveServerBinary(): Promise<ServerBinary> {
	const configured = vscode.workspace.getConfiguration('iwe').get<string>('serverPath', '').trim();
	if (configured) {
		const resolved = expandHome(configured);
		if (!fs.existsSync(resolved)) {
			throw new Error(`iwe.serverPath points to a file that does not exist: ${resolved}`);
		}
		return { path: resolved, source: 'setting' };
	}

	const fromPath = await findInPath(serverBinaryName(process.platform));
	if (fromPath) {
		return { path: fromPath, source: 'path' };
	}

	const cached = managedBinary();
	if (cached) {
		return cached;
	}

	const release = await fetchLatestRelease();
	await extensionContext.globalState.update(STATE_LAST_CHECK, Date.now());
	return downloadRelease(release, vscode.ProgressLocation.Notification);
}

async function downloadRelease(release: Release, location: vscode.ProgressLocation): Promise<ServerBinary> {
	downloadInProgress = true;
	try {
		const binaryPath = await vscode.window.withProgress(
			{ location, title: `Downloading IWE language server ${release.tag}` },
			() => installRelease(release, extensionContext.globalStorageUri.fsPath, process.platform, process.arch),
		);
		await extensionContext.globalState.update(STATE_BINARY_PATH, binaryPath);
		await extensionContext.globalState.update(STATE_BINARY_VERSION, release.tag);
		output.info(`Installed iwes ${release.tag} at ${binaryPath}`);
		return { path: binaryPath, source: 'managed', version: release.tag };
	} finally {
		downloadInProgress = false;
	}
}

function updateCheckDue(): boolean {
	const config = vscode.workspace.getConfiguration('iwe');
	if (!config.get<boolean>('autoUpdate', true)) {
		return false;
	}
	const intervalHours = Math.max(1, config.get<number>('updateCheckInterval', 24));
	const lastCheck = extensionContext.globalState.get<number>(STATE_LAST_CHECK, 0);
	return Date.now() - lastCheck >= intervalHours * HOUR_MS;
}

async function checkForUpdatesInBackground(installed: ServerBinary): Promise<void> {
	try {
		const release = await fetchLatestRelease();
		await extensionContext.globalState.update(STATE_LAST_CHECK, Date.now());
		if (!installed.version || !isNewerVersion(release.tag, installed.version)) {
			output.info(`iwes ${installed.version} is up to date`);
			return;
		}
		await downloadRelease(release, vscode.ProgressLocation.Window);
		const choice = await vscode.window.showInformationMessage(
			`IWE language server ${release.tag} is ready. Restart the server to use it.`,
			'Restart Now',
			'Release Notes',
		);
		if (choice === 'Restart Now') {
			await enqueue(restartLanguageServer);
		} else if (choice === 'Release Notes') {
			await vscode.env.openExternal(vscode.Uri.parse(`${RELEASE_PAGE_URL}${release.tag}`));
		}
	} catch (error) {
		output.warn(`Update check failed: ${errorMessage(error)}`);
	}
}

async function startLanguageServer(): Promise<void> {
	setStatus('$(sync~spin)', 'Starting IWE language server');
	let binary: ServerBinary;
	try {
		binary = await resolveServerBinary();
	} catch (error) {
		const message = `Failed to set up the IWE language server: ${errorMessage(error)}`;
		output.error(message);
		setStatus('$(error)', message);
		const choice = await vscode.window.showErrorMessage(message, 'Retry', 'Show Output');
		if (choice === 'Retry') {
			void enqueue(startLanguageServer);
		} else if (choice === 'Show Output') {
			output.show();
		}
		return;
	}

	currentBinary = binary;
	output.info(`Using ${describeBinary(binary).replace('\n', ' at ')}`);

	const cwd = serverWorkingDirectory();
	const env = vscode.workspace.getConfiguration('iwe').get<boolean>('debug', false)
		? { ...process.env, IWE_DEBUG: 'true' }
		: process.env;

	const serverOptions: ServerOptions = {
		command: binary.path,
		args: [],
		options: { cwd, env },
	};

	const watcher = cwd
		? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(cwd, '**/*.md'))
		: vscode.workspace.createFileSystemWatcher('**/*.md');

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'markdown' }],
		synchronize: { fileEvents: watcher },
		outputChannel: output,
		workspaceFolder: cwd ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd)) : undefined,
	};

	const languageClient = new LanguageClient('iwe', 'IWE Language Server', serverOptions, clientOptions);
	clientDisposables = [
		watcher,
		languageClient.onDidChangeState(event => {
			if (languageClient !== client) {
				return;
			}
			if (event.newState === State.Running) {
				setStatus('$(book)', describeBinary(binary));
			} else if (event.newState === State.Starting) {
				setStatus('$(sync~spin)', 'Starting IWE language server');
			} else {
				setStatus('$(error)', 'IWE language server stopped');
			}
		}),
	];
	client = languageClient;

	try {
		await languageClient.start();
	} catch (error) {
		const message = `IWE language server failed to start: ${errorMessage(error)}`;
		output.error(message);
		setStatus('$(error)', message);
		void vscode.window.showErrorMessage(message, 'Show Output').then(choice => {
			if (choice) {
				output.show();
			}
		});
		return;
	}

	if (binary.source === 'managed') {
		if (!downloadInProgress) {
			await removeOtherVersions(extensionContext.globalStorageUri.fsPath, path.dirname(binary.path));
		}
		if (updateCheckDue()) {
			void checkForUpdatesInBackground(binary);
		}
	}
}

async function stopClient(): Promise<void> {
	const stopping = client;
	client = undefined;
	const disposables = clientDisposables;
	clientDisposables = [];
	if (stopping) {
		try {
			await stopping.dispose();
		} catch (error) {
			output?.warn(`Failed to stop the language server cleanly: ${errorMessage(error)}`);
		}
	}
	disposables.forEach(disposable => disposable.dispose());
}

async function restartLanguageServer(): Promise<void> {
	await stopClient();
	await startLanguageServer();
}

async function updateLanguageServer(): Promise<void> {
	if (downloadInProgress) {
		void vscode.window.showInformationMessage('An IWE language server download is already in progress.');
		return;
	}
	const active = currentBinary ?? (await resolveServerBinary().catch(() => undefined));
	if (active && active.source !== 'managed') {
		const where = active.source === 'setting' ? 'the iwe.serverPath setting' : 'your PATH';
		void vscode.window.showInformationMessage(
			`IWE is using iwes from ${where} (${active.path}). Update it with the tool you installed it with, or remove it from ${where} to let the extension manage it.`,
		);
		return;
	}

	let release: Release;
	try {
		release = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Checking for IWE language server updates' },
			() => fetchLatestRelease(),
		);
		await extensionContext.globalState.update(STATE_LAST_CHECK, Date.now());
	} catch (error) {
		void vscode.window.showErrorMessage(`Failed to check for updates: ${errorMessage(error)}`);
		return;
	}

	if (active?.version && !isNewerVersion(release.tag, active.version)) {
		void vscode.window.showInformationMessage(`IWE language server ${active.version} is already the latest version.`);
		return;
	}

	try {
		await downloadRelease(release, vscode.ProgressLocation.Notification);
	} catch (error) {
		void vscode.window.showErrorMessage(`Failed to download IWE language server ${release.tag}: ${errorMessage(error)}`);
		return;
	}

	await restartLanguageServer();
	if (client?.isRunning()) {
		void vscode.window.showInformationMessage(`IWE language server updated to ${release.tag}.`, 'Release Notes').then(choice => {
			if (choice) {
				void vscode.env.openExternal(vscode.Uri.parse(`${RELEASE_PAGE_URL}${release.tag}`));
			}
		});
	}
}
