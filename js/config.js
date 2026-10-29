/**
 * Application Constants and Default Settings
 */

export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';

export const IGNORED_DIRS = new Set([
    '.git', '.vscode', 'node_modules', 'dist', 'build',
    '__pycache__', '.pytest_cache', '.venv', 'env', 'coverage', '.idea', 'target', 'vendor'
]);

export const IGNORED_FILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock',
    'poetry.lock', 'pipfile.lock', '.ds_store', 'thumbs.db'
]);
