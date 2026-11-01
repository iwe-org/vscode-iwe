import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import type { IncomingMessage } from 'http';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import * as yauzl from 'yauzl';

export const RELEASES_URL = 'https://api.github.com/repos/iwe-org/iwe/releases?per_page=30';
export const RELEASE_PAGE_URL = 'https://github.com/iwe-org/iwe/releases/tag/';
export const MANAGED_DIR_PREFIX = 'iwe-';

const USER_AGENT = 'IWE VS Code Extension';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const TAG_PATTERN = /^(?:iwe-)?v?(\d+)\.(\d+)\.(\d+)$/;

export interface ReleaseAsset {
	name: string;
	url: string;
}

export interface Release {
	tag: string;
	assets: ReleaseAsset[];
}

export interface PlatformAsset {
	archive: ReleaseAsset;
	checksum?: ReleaseAsset;
}

export function serverBinaryName(platform: NodeJS.Platform): string {
	return platform === 'win32' ? 'iwes.exe' : 'iwes';
}

export function parseVersion(tag: string): number[] | undefined {
	const match = TAG_PATTERN.exec(tag.trim());
	return match ? match.slice(1, 4).map(Number) : undefined;
}

export function isNewerVersion(candidate: string, current: string): boolean {
	const next = parseVersion(candidate);
	if (!next) {
		return false;
	}
	const installed = parseVersion(current);
	if (!installed) {
		return true;
	}
	for (let i = 0; i < next.length; i++) {
		if (next[i] !== installed[i]) {
			return next[i] > installed[i];
		}
	}
	return false;
}

export function pickLatestRelease(raw: unknown): Release | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	let latest: Release | undefined;
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const release = entry as Record<string, unknown>;
		const tag = release.tag_name;
		if (typeof tag !== 'string' || release.draft === true || release.prerelease === true || !parseVersion(tag)) {
			continue;
		}
		const assets = Array.isArray(release.assets)
			? release.assets
				.filter((asset): asset is { name: string; browser_download_url: string } =>
					typeof asset?.name === 'string' && typeof asset?.browser_download_url === 'string')
				.map(asset => ({ name: asset.name, url: asset.browser_download_url }))
			: [];
		if (assets.length === 0) {
			continue;
		}
		if (!latest || isNewerVersion(tag, latest.tag)) {
			latest = { tag, assets };
		}
	}
	return latest;
}

export function platformTargets(platform: NodeJS.Platform, arch: string): string[] {
	switch (platform) {
		case 'darwin':
			return arch === 'arm64'
				? ['aarch64-apple-darwin', 'universal-apple-darwin']
				: ['x86_64-apple-darwin', 'universal-apple-darwin'];
		case 'linux':
			if (arch === 'arm64') {
				return ['aarch64-unknown-linux-musl', 'aarch64-unknown-linux-gnu'];
			}
			if (arch === 'x64') {
				return ['x86_64-unknown-linux-musl', 'x86_64-unknown-linux-gnu'];
			}
			break;
		case 'win32':
			if (arch === 'x64' || arch === 'arm64') {
				return ['x86_64-pc-windows-msvc'];
			}
			break;
	}
	throw new Error(`IWE does not provide a language server binary for ${platform}-${arch}`);
}

export function selectPlatformAsset(release: Release, platform: NodeJS.Platform, arch: string): PlatformAsset | undefined {
	const extension = platform === 'win32' ? '.zip' : '.tar.gz';
	for (const target of platformTargets(platform, arch)) {
		const base = `${release.tag}-${target}`;
		const archive = release.assets.find(asset => asset.name === `${base}${extension}`);
		if (archive) {
			return {
				archive,
				checksum: release.assets.find(asset => asset.name === `${base}.sha256`),
			};
		}
	}
	return undefined;
}

export function parseChecksum(content: string): string | undefined {
	const token = content.trim().split(/\s+/)[0];
	return token && /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : undefined;
}

function request(url: string, accept: string, redirects = MAX_REDIRECTS): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept } }, response => {
			const status = response.statusCode ?? 0;
			const location = response.headers.location;
			if (status >= 300 && status < 400 && location) {
				response.resume();
				if (redirects <= 0) {
					reject(new Error(`Too many redirects while fetching ${url}`));
					return;
				}
				resolve(request(new URL(location, url).toString(), accept, redirects - 1));
				return;
			}
			if (status !== 200) {
				response.resume();
				const hint = status === 403 || status === 429 ? ' (GitHub rate limit reached, try again later)' : '';
				reject(new Error(`Request to ${url} failed with status ${status}${hint}`));
				return;
			}
			resolve(response);
		});
		req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Request to ${url} timed out`)));
		req.on('error', reject);
	});
}

async function fetchText(url: string, accept: string): Promise<string> {
	const response = await request(url, accept);
	response.setEncoding('utf8');
	let body = '';
	for await (const chunk of response) {
		body += chunk;
	}
	return body;
}

export async function fetchLatestRelease(): Promise<Release> {
	const body = await fetchText(RELEASES_URL, 'application/vnd.github+json');
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error('GitHub returned an invalid release list');
	}
	const release = pickLatestRelease(parsed);
	if (!release) {
		throw new Error('No IWE release found on GitHub');
	}
	return release;
}

async function downloadFile(url: string, destination: string): Promise<void> {
	const response = await request(url, 'application/octet-stream');
	await pipeline(response, fs.createWriteStream(destination));
}

async function sha256File(file: string): Promise<string> {
	const hash = crypto.createHash('sha256');
	await pipeline(fs.createReadStream(file), hash);
	return hash.digest('hex');
}

function extractZipEntry(zipPath: string, entryName: string, destination: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
			if (openError || !zipfile) {
				reject(openError ?? new Error('Failed to open zip archive'));
				return;
			}
			let settled = false;
			const finish = (error: Error | undefined, found: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				zipfile.close();
				if (error) {
					reject(error);
				} else {
					resolve(found);
				}
			};
			zipfile.on('error', error => finish(error, false));
			zipfile.on('end', () => finish(undefined, false));
			zipfile.on('entry', (entry: yauzl.Entry) => {
				if (path.posix.basename(entry.fileName) !== entryName || entry.fileName.endsWith('/')) {
					zipfile.readEntry();
					return;
				}
				zipfile.openReadStream(entry, (streamError, stream) => {
					if (streamError || !stream) {
						finish(streamError ?? new Error('Failed to read zip entry'), false);
						return;
					}
					pipeline(stream, fs.createWriteStream(destination)).then(
						() => finish(undefined, true),
						error => finish(error, false),
					);
				});
			});
			zipfile.readEntry();
		});
	});
}

async function findFile(directory: string, name: string): Promise<string | undefined> {
	const entries = await fs.promises.readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(directory, entry.name);
		if (entry.isFile() && entry.name === name) {
			return full;
		}
		if (entry.isDirectory()) {
			const nested = await findFile(full, name);
			if (nested) {
				return nested;
			}
		}
	}
	return undefined;
}

export function managedDirectory(storageDir: string, tag: string): string {
	return path.join(storageDir, `${MANAGED_DIR_PREFIX}${tag}`);
}

export async function installRelease(
	release: Release,
	storageDir: string,
	platform: NodeJS.Platform,
	arch: string,
): Promise<string> {
	const asset = selectPlatformAsset(release, platform, arch);
	if (!asset) {
		throw new Error(`Release ${release.tag} has no language server binary for ${platform}-${arch}`);
	}
	const binaryName = serverBinaryName(platform);
	await fs.promises.mkdir(storageDir, { recursive: true });
	const workDir = await fs.promises.mkdtemp(path.join(storageDir, 'download-'));
	try {
		const archivePath = path.join(workDir, asset.archive.name);
		await downloadFile(asset.archive.url, archivePath);

		if (asset.checksum) {
			const expected = parseChecksum(await fetchText(asset.checksum.url, 'text/plain'));
			if (!expected) {
				throw new Error(`Checksum file ${asset.checksum.name} is malformed`);
			}
			const actual = await sha256File(archivePath);
			if (actual !== expected) {
				throw new Error(`Checksum mismatch for ${asset.archive.name}`);
			}
		}

		const extractDir = path.join(workDir, 'extract');
		await fs.promises.mkdir(extractDir);
		let extracted: string | undefined;
		if (asset.archive.name.endsWith('.zip')) {
			const target = path.join(extractDir, binaryName);
			extracted = (await extractZipEntry(archivePath, binaryName, target)) ? target : undefined;
		} else {
			await tar.x({
				file: archivePath,
				cwd: extractDir,
				filter: entryPath => path.posix.basename(entryPath) === binaryName,
			});
			extracted = await findFile(extractDir, binaryName);
		}
		if (!extracted) {
			throw new Error(`${binaryName} not found in ${asset.archive.name}`);
		}

		const versionDir = managedDirectory(storageDir, release.tag);
		await fs.promises.rm(versionDir, { recursive: true, force: true });
		await fs.promises.mkdir(versionDir, { recursive: true });
		const binaryPath = path.join(versionDir, binaryName);
		await fs.promises.copyFile(extracted, binaryPath);
		if (platform !== 'win32') {
			await fs.promises.chmod(binaryPath, 0o755);
		}
		return binaryPath;
	} finally {
		await fs.promises.rm(workDir, { recursive: true, force: true });
	}
}

export async function removeOtherVersions(storageDir: string, keepDir: string): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(storageDir, { withFileTypes: true });
	} catch {
		return;
	}
	const keep = path.resolve(keepDir);
	for (const entry of entries) {
		const full = path.resolve(storageDir, entry.name);
		const stale = entry.name.startsWith(MANAGED_DIR_PREFIX) || entry.name.startsWith('download-');
		if (entry.isDirectory() && stale && full !== keep) {
			await fs.promises.rm(full, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

export async function findInPath(binaryName: string, searchPath = process.env.PATH ?? ''): Promise<string | undefined> {
	for (const directory of searchPath.split(path.delimiter)) {
		if (!directory) {
			continue;
		}
		const candidate = path.join(directory, binaryName);
		try {
			await fs.promises.access(candidate, fs.constants.X_OK);
			if ((await fs.promises.stat(candidate)).isFile()) {
				return candidate;
			}
		} catch {
			continue;
		}
	}
	return undefined;
}
