import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { DiffSide, encodeDiffDocUri } from './diffDocProvider';
import { ExtensionState } from './extensionState';
import { ErrorInfo, GitFileStatus, PullRequestConfig, PullRequestProvider } from './types';

export const UNCOMMITTED = '*';
export const UNABLE_TO_FIND_GIT_MSG = 'Unable to find a Git executable. Either: Set the Visual Studio Code Setting "git.path" to the path and filename of an existing Git executable, or install Git and restart Visual Studio Code.';


/* Path Manipulation */

const FS_REGEX = /\\/g;

/**
 * Get the normalised path of a URI.
 * @param uri The URI.
 * @returns The normalised path.
 */
export function getPathFromUri(uri: vscode.Uri) {
	return uri.fsPath.replace(FS_REGEX, '/');
}

/**
 * Get the normalised path of a string.
 * @param str The string.
 * @returns The normalised path.
 */
export function getPathFromStr(str: string) {
	return str.replace(FS_REGEX, '/');
}

/**
 * Get the path with a trailing slash.
 * @param path The path.
 * @returns The path with a trailing slash.
 */
export function pathWithTrailingSlash(path: string) {
	return path.endsWith('/') ? path : path + '/';
}

/**
 * Check whether a path is within the current Visual Studio Code Workspace.
 * @param path The path to check.
 * @returns TRUE => Path is in workspace, FALSE => Path isn't in workspace.
 */
export function isPathInWorkspace(path: string) {
	let rootsExact = [], rootsFolder = [], workspaceFolders = vscode.workspace.workspaceFolders;
	if (typeof workspaceFolders !== 'undefined') {
		for (let i = 0; i < workspaceFolders.length; i++) {
			let tmpPath = getPathFromUri(workspaceFolders[i].uri);
			rootsExact.push(tmpPath);
			rootsFolder.push(pathWithTrailingSlash(tmpPath));
		}
	}
	return rootsExact.indexOf(path) > -1 || rootsFolder.findIndex(x => path.startsWith(x)) > -1;
}

/**
 * Get the normalised canonical absolute path (i.e. resolves symlinks in `path`).
 * @param path The path.
 * @returns The normalised canonical absolute path.
 */
export function realpath(path: string) {
	return new Promise<string>(resolve => {
		fs.realpath(path, (err, resolvedPath) => resolve(err !== null ? path : getPathFromUri(vscode.Uri.file(resolvedPath))));
	});
}

/**
 * Transform the path from a canonical absolute path to use symbolic links if the containing Visual Studio Code workspace folder has symbolic link(s).
 * @param path The canonical absolute path.
 * @returns The transformed path.
 */
export async function resolveToSymbolicPath(path: string) {
	let workspaceFolders = vscode.workspace.workspaceFolders;
	if (typeof workspaceFolders !== 'undefined') {
		for (let i = 0; i < workspaceFolders.length; i++) {
			let rootSymPath = getPathFromUri(workspaceFolders[i].uri);
			let rootCanonicalPath = await realpath(rootSymPath);
			if (path === rootCanonicalPath) {
				return rootSymPath;
			} else if (path.startsWith(rootCanonicalPath + '/')) {
				return rootSymPath + path.substring(rootCanonicalPath.length);
			} else if (rootCanonicalPath.startsWith(path + '/')) {
				let symPath = rootSymPath;
				let first = symPath.indexOf('/');
				while (true) {
					if (path === symPath || path === await realpath(symPath)) return symPath;
					let next = symPath.lastIndexOf('/');
					if (first !== next && next > -1) {
						symPath = symPath.substring(0, next);
					} else {
						return path;
					}
				}
			}
		}
	}
	return path;
}


/* General Methods */

/**
 * Abbreviate a commit hash to the first eight characters.
 * @param commitHash The full commit hash.
 * @returns The abbreviated commit hash.
 */
export function abbrevCommit(commitHash: string) {
	return commitHash.substring(0, 8);
}

/**
 * Abbreviate a string to the specified number of characters.
 * @param text The string to abbreviate.
 * @param toChars The number of characters to abbreviate the string to.
 * @returns The abbreviated string.
 */
export function abbrevText(text: string, toChars: number) {
	return text.length <= toChars ? text : text.substring(0, toChars - 1) + '...';
}

/**
 * Get the relative time difference between the current time and a Unix timestamp.
 * @param unixTimestamp The Unix timestamp.
 * @returns The relative time difference (e.g. 12 minutes ago).
 */
export function getRelativeTimeDiff(unixTimestamp: number) {
	let diff = Math.round((new Date()).getTime() / 1000) - unixTimestamp, unit;
	if (diff < 60) {
		unit = 'second';
	} else if (diff < 3600) {
		unit = 'minute';
		diff /= 60;
	} else if (diff < 86400) {
		unit = 'hour';
		diff /= 3600;
	} else if (diff < 604800) {
		unit = 'day';
		diff /= 86400;
	} else if (diff < 2629800) {
		unit = 'week';
		diff /= 604800;
	} else if (diff < 31557600) {
		unit = 'month';
		diff /= 2629800;
	} else {
		unit = 'year';
		diff /= 31557600;
	}
	diff = Math.round(diff);
	return diff + ' ' + unit + (diff !== 1 ? 's' : '') + ' ago';
}

/**
 * Randomly generate a nonce.
 * @returns The nonce.
 */
export function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

/**
 * Get a short name for a repository.
 * @param path The path of the repository.
 * @returns The short name.
 */
export function getRepoName(path: string) {
	let firstSep = path.indexOf('/');
	if (firstSep === path.length - 1 || firstSep === -1) {
		return path; // Path has no slashes, or a single trailing slash ==> use the path
	} else {
		let p = path.endsWith('/') ? path.substring(0, path.length - 1) : path; // Remove trailing slash if it exists
		return p.substring(p.lastIndexOf('/') + 1);
	}
}


/* Visual Studio Code Command Wrappers */

/**
 * Copy the path of a file in a repository to the clipboard.
 * @param repo The repository the file is contained in.
 * @param filePath The relative path of the file within the repository.
 */
export function copyFilePathToClipboard(repo: string, filePath: string) {
	return copyToClipboard(path.join(repo, filePath));
}

/**
 * Copy a string to the clipboard.
 * @param text The string.
 */
export function copyToClipboard(text: string): Thenable<ErrorInfo> {
	return vscode.env.clipboard.writeText(text).then(
		() => null,
		() => 'Visual Studio Code was unable to write to the Clipboard.'
	);
}

/**
 * Construct the URL for creating a new Pull Request, and open it in the users default web browser.
 * @param config The Pull Request Provider's Configuration.
 * @param sourceOwner The owner of the repository that is the source of the Pull Request.
 * @param sourceRepo The name of the repository that is the source of the Pull Request.
 * @param sourceBranch The source branch the Pull Request should be created from.
 */
export function createPullRequest(config: PullRequestConfig, sourceOwner: string, sourceRepo: string, sourceBranch: string) {
	let templateUrl;
	switch (config.provider) {
		case PullRequestProvider.Bitbucket:
			templateUrl = '$1/$2/$3/pull-requests/new?source=$2/$3::$4&dest=$5/$6::$8';
			break;
		case PullRequestProvider.Custom:
			templateUrl = config.custom.templateUrl;
			break;
		case PullRequestProvider.GitHub:
			templateUrl = '$1/$5/$6/compare/$8...$2:$4';
			break;
		case PullRequestProvider.GitLab:
			templateUrl = '$1/$2/$3/-/merge_requests/new?merge_request[source_branch]=$4&merge_request[target_branch]=$8' +
				(config.destProjectId !== '' ? '&merge_request[target_project_id]=$7' : '');
			break;
	}

	const urlFieldValues = [
		config.hostRootUrl,
		sourceOwner, sourceRepo, sourceBranch,
		config.destOwner, config.destRepo, config.destProjectId, config.destBranch
	];

	const url = templateUrl.replace(/\$([1-8])/g, (_, index) => urlFieldValues[parseInt(index) - 1]);

	return vscode.env.openExternal(vscode.Uri.parse(url)).then(
		() => null,
		() => 'Visual Studio Code was unable to open the Pull Request URL: ' + url
	);
}

/**
 * Open the Visual Studio Code Settings Editor to the Git Graph Extension Settings.
 */
export function openExtensionSettings(): Thenable<ErrorInfo> {
	return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:mhutchie.git-graph').then(
		() => null,
		() => 'Visual Studio Code was unable to open the Git Graph Extension Settings.'
	);
}

/**
 * Open a file within a repository in Visual Studio Code.
 * @param repo The repository the file is contained in.
 * @param filePath The relative path of the file within the repository.
 */
export function openFile(repo: string, filePath: string) {
	return new Promise<ErrorInfo>(resolve => {
		const p = path.join(repo, filePath);
		fs.access(p, fs.constants.R_OK, (err) => {
			if (err === null) {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p), {
					preview: true,
					viewColumn: getConfig().openDiffTabLocation
				}).then(
					() => resolve(null),
					() => resolve('Visual Studio Code was unable to open ' + filePath + '.')
				);
			} else {
				resolve('The file ' + filePath + ' doesn\'t currently exist in this repository.');
			}
		});
	});
}

/**
 * Open the Visual Studio Code Diff View for a specific Git file change.
 * @param repo The repository the file is contained in.
 * @param fromHash The revision of the left-side of the Diff View.
 * @param toHash The revision of the right-side of the Diff View.
 * @param oldFilePath The relative path of the left-side file within the repository.
 * @param newFilePath The relative path of the right-side file within the repository.
 * @param type The Git file status of the change.
 */
export function viewDiff(repo: string, fromHash: string, toHash: string, oldFilePath: string, newFilePath: string, type: GitFileStatus) {
	if (type !== GitFileStatus.Untracked) {
		let abbrevFromHash = abbrevCommit(fromHash), abbrevToHash = toHash !== UNCOMMITTED ? abbrevCommit(toHash) : 'Present', pathComponents = newFilePath.split('/');
		let desc = fromHash === toHash
			? fromHash === UNCOMMITTED
				? 'Uncommitted'
				: (type === GitFileStatus.Added ? 'Added in ' + abbrevToHash : type === GitFileStatus.Deleted ? 'Deleted in ' + abbrevToHash : abbrevFromHash + '^ ↔ ' + abbrevToHash)
			: (type === GitFileStatus.Added ? 'Added between ' + abbrevFromHash + ' & ' + abbrevToHash : type === GitFileStatus.Deleted ? 'Deleted between ' + abbrevFromHash + ' & ' + abbrevToHash : abbrevFromHash + ' ↔ ' + abbrevToHash);
		let title = pathComponents[pathComponents.length - 1] + ' (' + desc + ')';
		if (fromHash === UNCOMMITTED) fromHash = 'HEAD';

		return vscode.commands.executeCommand('vscode.diff', encodeDiffDocUri(repo, oldFilePath, fromHash === toHash ? fromHash + '^' : fromHash, type, DiffSide.Old), encodeDiffDocUri(repo, newFilePath, toHash, type, DiffSide.New), title, {
			preview: true,
			viewColumn: getConfig().openDiffTabLocation
		}).then(
			() => null,
			() => 'Visual Studio Code was unable load the diff editor for ' + newFilePath + '.'
		);
	} else {
		return openFile(repo, newFilePath);
	}
}

export async function viewFileAtRevision(repo: string, hash: string, filePath: string) {
	const pathComponents = filePath.split('/');
	const title = abbrevCommit(hash) + ': ' + pathComponents[pathComponents.length - 1];

	return vscode.commands.executeCommand('vscode.open', encodeDiffDocUri(repo, filePath, hash, GitFileStatus.Modified, DiffSide.New).with({ path: title }), {
		preview: true,
		viewColumn: getConfig().openDiffTabLocation
	}).then(
		() => null,
		() => 'Visual Studio Code was unable to open ' + filePath + ' at commit ' + abbrevCommit(hash) + '.'
	);
}

/**
 * Open the Visual Studio Code Source Control View.
 */
export function viewScm(): Thenable<ErrorInfo> {
	return vscode.commands.executeCommand('workbench.view.scm').then(
		() => null,
		() => 'Visual Studio Code was unable to open the Source Control View.'
	);
}

/**
 * Open a new terminal and run the specified Git command.
 * @param cwd The working directory for the terminal.
 * @param gitPath The path of the Git executable.
 * @param command The Git command to run.
 * @param name The name for the terminal.
 */
export function runGitCommandInNewTerminal(cwd: string, gitPath: string, command: string, name: string) {
	let p = process.env['PATH'] || '', sep = isWindows() ? ';' : ':';
	if (p !== '' && !p.endsWith(sep)) p += sep;
	p += path.dirname(gitPath);

	let options: vscode.TerminalOptions = { cwd: cwd, name: name, env: { 'PATH': p } };
	let shell = getConfig().integratedTerminalShell;
	if (shell !== '') options.shellPath = shell;

	let terminal = vscode.window.createTerminal(options);
	terminal.sendText('git ' + command);
	terminal.show();
}

/**
 * Check whether Git Graph is running on a Windows-based platform.
 * @returns TRUE => Windows-based platform, FALSE => Not a Windows-based platform.
 */
function isWindows() {
	return process.platform === 'win32' || process.env.OSTYPE === 'cygwin' || process.env.OSTYPE === 'msys';
}


/* Visual Studio Code API Wrappers */

/**
 * Show a Visual Studio Code Information Message Dialog with the specified message.
 * @param message The message to show.
 */
export function showInformationMessage(message: string) {
	return vscode.window.showInformationMessage(message).then(() => { }, () => { });
}

/**
 * Show a Visual Studio Code Error Message Dialog with the specified message.
 * @param message The message to show.
 */
export function showErrorMessage(message: string) {
	return vscode.window.showErrorMessage(message).then(() => { }, () => { });
}


/* Promise Methods */

/**
 * Evaluate promises in parallel, with at most `maxParallel` running at any point in time.
 * @param data The array of elements to be mapped via promises.
 * @param maxParallel The maximum number of promises to run at any point in time.
 * @param createPromise A function that creates a promise from an element of `data`.
 * @returns A result array evaluated by mapping promises generated from `data`.
 */
export function evalPromises<X, Y>(data: X[], maxParallel: number, createPromise: (val: X) => Promise<Y>) {
	return new Promise<Y[]>((resolve, reject) => {
		if (data.length === 1) {
			createPromise(data[0]).then(v => resolve([v])).catch(() => reject());
		} else if (data.length === 0) {
			resolve([]);
		} else {
			let results: Y[] = new Array(data.length), nextPromise = 0, rejected = false, completed = 0;
			function startNext() {
				let cur = nextPromise;
				nextPromise++;
				createPromise(data[cur]).then(result => {
					if (!rejected) {
						results[cur] = result;
						completed++;
						if (nextPromise < data.length) startNext();
						else if (completed === data.length) resolve(results);
					}
				}).catch(() => {
					reject();
					rejected = true;
				});
			}
			for (let i = 0; i < maxParallel && i < data.length; i++) startNext();
		}
	});
}


/* Find Git Executable */

// The following code matches the behaviour of equivalent functions in Visual Studio Code's Git Extension,
// however was rewritten to meet the needs of this extension.
// The original code has the following copyright notice "Copyright (c) 2015 - present Microsoft Corporation",
// and is licensed under the MIT License provided in ./licenses/LICENSE_MICROSOFT.
// https://github.com/microsoft/vscode/blob/473af338e1bd9ad4d9853933da1cd9d5d9e07dc9/extensions/git/src/git.ts#L44-L135

export interface GitExecutable {
	path: string;
	version: string;
}

/**
 * Find a Git executable that Git Graph can use.
 * @param extensionState The Git Graph ExtensionState instance.
 * @returns A Git executable.
 */
export async function findGit(extensionState: ExtensionState) {
	const lastKnownPath = extensionState.getLastKnownGitPath();
	if (lastKnownPath !== null) {
		try {
			return await getGitExecutable(lastKnownPath);
		} catch (_) { }
	}

	const configGitPath = getConfig().gitPath;
	if (configGitPath !== null) {
		try {
			return await getGitExecutable(configGitPath);
		} catch (_) { }
	}

	switch (process.platform) {
		case 'darwin':
			return findGitOnDarwin();
		case 'win32':
			return findGitOnWin32();
		default:
			return getGitExecutable('git');
	}
}

/**
 * Find a Git executable on a Darwin-based platform that Git Graph can use.
 * @returns A Git executable.
 */
function findGitOnDarwin() {
	return new Promise<GitExecutable>((resolve, reject) => {
		cp.exec('which git', (err, stdout) => {
			if (err) return reject();

			const path = stdout.trim();
			if (path !== '/usr/bin/git') {
				getGitExecutable(path).then((exec) => resolve(exec), () => reject());
			} else {
				// must check if XCode is installed
				cp.exec('xcode-select -p', (err: any) => {
					if (err && err.code === 2) {
						// git is not installed, and launching /usr/bin/git will prompt the user to install it
						reject();
					} else {
						getGitExecutable(path).then((exec) => resolve(exec), () => reject());
					}
				});
			}
		});
	});
}

/**
 * Find a Git executable on a Windows-based platform that Git Graph can use.
 * @returns A Git executable.
 */
function findGitOnWin32() {
	return findSystemGitWin32(process.env['ProgramW6432'])
		.then(undefined, () => findSystemGitWin32(process.env['ProgramFiles(x86)']))
		.then(undefined, () => findSystemGitWin32(process.env['ProgramFiles']))
		.then(undefined, () => findSystemGitWin32(process.env['LocalAppData'] ? path.join(process.env['LocalAppData']!, 'Programs') : undefined))
		.then(undefined, () => findGitWin32InPath());
}
function findSystemGitWin32(pathBase?: string) {
	return pathBase
		? getGitExecutable(path.join(pathBase, 'Git', 'cmd', 'git.exe'))
		: Promise.reject<GitExecutable>();
}
async function findGitWin32InPath() {
	let dirs = (process.env['PATH'] || '').split(';');
	dirs.unshift(process.cwd());

	for (let i = 0; i < dirs.length; i++) {
		let file = path.join(dirs[i], 'git.exe');
		if (await isExecutable(file)) {
			try {
				return await getGitExecutable(file);
			} catch (_) { }
		}
	}
	return Promise.reject<GitExecutable>();
}

/**
 * Checks whether a path is an executable (a file that's not a symbolic link).
 * @param path The path to test.
 * @returns TRUE => Executable, FALSE => Not an Executable.
 */
function isExecutable(path: string) {
	return new Promise<boolean>(resolve => {
		fs.stat(path, (err, stat) => {
			resolve(!err && (stat.isFile() || stat.isSymbolicLink()));
		});
	});
}

/**
 * Gets information about a Git executable.
 * @param path The path of the Git executable.
 * @returns The GitExecutable data.
 */
export function getGitExecutable(path: string): Promise<GitExecutable> {
	return new Promise<GitExecutable>((resolve, reject) => {
		const cmd = cp.spawn(path, ['--version']);
		let stdout = '';
		cmd.stdout.on('data', (d) => { stdout += d; });
		cmd.on('error', () => reject());
		cmd.on('exit', (code) => {
			if (code) {
				reject();
			} else {
				resolve({ path: path, version: stdout.trim().replace(/^git version /, '') });
			}
		});
	});
}


/* Git Version Handling */

/**
 * Checks whether a Git executable is at least the specified version.
 * @param executable The Git executable to check.
 * @param version The minimum required version.
 * @returns TRUE => `executable` is at least `version`, FALSE => `executable` is older than `version`.
 */
export function isGitAtLeastVersion(executable: GitExecutable, version: string) {
	const v1 = parseVersion(executable.version);
	const v2 = parseVersion(version);

	if (v1 === null || v2 === null) {
		// Unable to parse a version number
		return false;
	}

	if (v1.major > v2.major) return true; // Git major version is newer
	if (v1.major < v2.major) return false; // Git major version is older

	if (v1.minor > v2.minor) return true; // Git minor version is newer
	if (v1.minor < v2.minor) return false; // Git minor version is older

	if (v1.patch > v2.patch) return true; // Git patch version is newer
	if (v1.patch < v2.patch) return false; // Git patch version is older

	return true; // Versions are the same
}

/**
 * Parse a version number from a string.
 * @param version The string version number.
 * @returns The `major`.`minor`.`patch` version numbers.
 */
function parseVersion(version: string) {
	try {
		const v = version.split(/[^0-9\.]+/)[0].split('.');
		return {
			major: v.length > 0 ? parseInt(v[0], 10) : 0,
			minor: v.length > 1 ? parseInt(v[1], 10) : 0,
			patch: v.length > 2 ? parseInt(v[2], 10) : 0
		};
	} catch (_) {
		return null;
	}
}

/**
 * Construct a message that explains to the user that the Git executable is not compatible with a feature.
 * @param executable The Git executable.
 * @param version The minimum required version number.
 * @returns The message for the user.
 */
export function constructIncompatibleGitVersionMessage(executable: GitExecutable, version: string) {
	return 'A newer version of Git (>= ' + version + ') is required for this feature. Git ' + executable.version + ' is currently installed. Please install a newer version of Git to use this feature.';
}
