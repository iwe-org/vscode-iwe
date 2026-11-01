# Change Log

## 0.0.5

### Added

- Commands **IWE: Restart Language Server** and **IWE: Show Output**
- `iwe.serverPath` setting to use a specific `iwes` binary
- `iwe.debug` setting to start the server with `IWE_DEBUG`
- `iwe.trace.server` setting to log LSP traffic
- Status bar item showing the server state and version
- Progress notification while the language server downloads
- SHA-256 verification of downloaded releases
- Activation in workspaces that contain `.iwe/config.toml`

### Changed

- Linux uses the static musl build, so the server runs on distributions with an older glibc. Earlier releases fall back to the glibc build.
- macOS downloads the native build for the current architecture instead of the universal binary
- Update checks run in the background after the server starts, so a slow or offline network no longer delays startup. When an update is ready, the extension offers to restart the server.
- The server runs in the workspace folder that contains `.iwe/config.toml`
- Updating the extension no longer discards the downloaded server, so it still starts offline
- Upgraded `vscode-languageclient` to 11 and `tar` to 7, and removed the `which` dependency

### Fixed

- Activation could hang forever when GitHub returned an error or hit its rate limit
- Version comparison failed for `iwe-vX.Y.Z` release tags
- Releases of other crates in the repository could be picked as the latest server release
- The server was started with an empty-string argument
- The update command reported success even when the server failed to start
- The file watcher leaked on every restart
- Downloads could hang without a timeout
- Removed the `IWE` command that did nothing

## 0.0.1

- Initial release
