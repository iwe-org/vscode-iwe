import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	findInPath,
	isNewerVersion,
	parseChecksum,
	parseVersion,
	pickLatestRelease,
	platformTargets,
	removeOtherVersions,
	selectPlatformAsset,
} from '../release';

function asset(name: string) {
	return { name, browser_download_url: `https://example.com/${name}` };
}

suite('release', () => {
	test('parseVersion accepts current and legacy tag formats', () => {
		assert.deepStrictEqual(parseVersion('iwe-v0.29.3'), [0, 29, 3]);
		assert.deepStrictEqual(parseVersion('v1.2.10'), [1, 2, 10]);
		assert.deepStrictEqual(parseVersion('0.0.30'), [0, 0, 30]);
		assert.strictEqual(parseVersion('liwe-v0.29.3'), undefined);
		assert.strictEqual(parseVersion('iwe-v0.29.3-rc1'), undefined);
	});

	test('isNewerVersion compares numerically across tag formats', () => {
		assert.strictEqual(isNewerVersion('iwe-v0.29.3', 'iwe-v0.29.2'), true);
		assert.strictEqual(isNewerVersion('iwe-v0.30.0', 'iwe-v0.29.10'), true);
		assert.strictEqual(isNewerVersion('iwe-v1.0.0', 'iwe-v0.99.99'), true);
		assert.strictEqual(isNewerVersion('iwe-v0.29.3', 'iwe-v0.29.3'), false);
		assert.strictEqual(isNewerVersion('iwe-v0.29.2', 'iwe-v0.29.3'), false);
		assert.strictEqual(isNewerVersion('iwe-v0.29.3', 'v0.0.30'), true);
		assert.strictEqual(isNewerVersion('iwe-v0.29.3', 'garbage'), true);
		assert.strictEqual(isNewerVersion('garbage', 'iwe-v0.29.3'), false);
	});

	test('pickLatestRelease skips drafts, prereleases, other crates and empty releases', () => {
		const release = pickLatestRelease([
			{ tag_name: 'iwe-v0.30.0', prerelease: true, assets: [asset('a')] },
			{ tag_name: 'iwe-v0.31.0', draft: true, assets: [asset('a')] },
			{ tag_name: 'liwe-v0.40.0', assets: [asset('a')] },
			{ tag_name: 'iwe-v0.29.4', assets: [] },
			{ tag_name: 'iwe-v0.29.2', assets: [asset('old')] },
			{ tag_name: 'iwe-v0.29.3', assets: [asset('new')] },
		]);
		assert.strictEqual(release?.tag, 'iwe-v0.29.3');
		assert.deepStrictEqual(release?.assets, [{ name: 'new', url: 'https://example.com/new' }]);
		assert.strictEqual(pickLatestRelease({ message: 'API rate limit exceeded' }), undefined);
	});

	test('platformTargets prefers native and static builds', () => {
		assert.deepStrictEqual(platformTargets('darwin', 'arm64'), ['aarch64-apple-darwin', 'universal-apple-darwin']);
		assert.deepStrictEqual(platformTargets('linux', 'x64'), ['x86_64-unknown-linux-musl', 'x86_64-unknown-linux-gnu']);
		assert.deepStrictEqual(platformTargets('win32', 'arm64'), ['x86_64-pc-windows-msvc']);
		assert.throws(() => platformTargets('freebsd', 'x64'));
		assert.throws(() => platformTargets('linux', 'ia32'));
	});

	test('selectPlatformAsset falls back when the preferred build is missing', () => {
		const tag = 'iwe-v0.29.1';
		const release = {
			tag,
			assets: [
				`${tag}-x86_64-unknown-linux-gnu.tar.gz`,
				`${tag}-x86_64-unknown-linux-gnu.sha256`,
				`${tag}-universal-apple-darwin.tar.gz`,
				`${tag}-x86_64-pc-windows-msvc.zip`,
			].map(name => ({ name, url: name })),
		};
		const linux = selectPlatformAsset(release, 'linux', 'x64');
		assert.strictEqual(linux?.archive.name, `${tag}-x86_64-unknown-linux-gnu.tar.gz`);
		assert.strictEqual(linux?.checksum?.name, `${tag}-x86_64-unknown-linux-gnu.sha256`);
		const mac = selectPlatformAsset(release, 'darwin', 'arm64');
		assert.strictEqual(mac?.archive.name, `${tag}-universal-apple-darwin.tar.gz`);
		assert.strictEqual(mac?.checksum, undefined);
		assert.strictEqual(selectPlatformAsset(release, 'win32', 'x64')?.archive.name, `${tag}-x86_64-pc-windows-msvc.zip`);
		assert.strictEqual(selectPlatformAsset(release, 'linux', 'arm64'), undefined);
	});

	test('parseChecksum reads sha256sum output', () => {
		const hash = '7efa6be68deb5cc6324884042c49930b525387bc98875338b1f9fd06852ceea1';
		assert.strictEqual(parseChecksum(`${hash}  iwe-v0.29.3-universal-apple-darwin.tar.gz\n`), hash);
		assert.strictEqual(parseChecksum(hash.toUpperCase()), hash);
		assert.strictEqual(parseChecksum('not a hash'), undefined);
	});

	test('findInPath and removeOtherVersions work on the file system', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'iwe-test-'));
		try {
			const bin = path.join(root, 'bin');
			await fs.promises.mkdir(bin);
			const binary = path.join(bin, 'iwes-test');
			await fs.promises.writeFile(binary, '');
			await fs.promises.chmod(binary, 0o755);
			assert.strictEqual(await findInPath('iwes-test', ['', path.join(root, 'missing'), bin].join(path.delimiter)), binary);
			assert.strictEqual(await findInPath('iwes-missing', bin), undefined);

			const storage = path.join(root, 'storage');
			for (const name of ['iwe-iwe-v0.29.2', 'iwe-iwe-v0.29.3', 'download-abc', 'other']) {
				await fs.promises.mkdir(path.join(storage, name), { recursive: true });
			}
			await removeOtherVersions(storage, path.join(storage, 'iwe-iwe-v0.29.3'));
			assert.deepStrictEqual((await fs.promises.readdir(storage)).sort(), ['iwe-iwe-v0.29.3', 'other']);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
