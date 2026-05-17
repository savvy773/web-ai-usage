import path from 'node:path';

export const DATA_DIR = path.join(process.cwd(), 'data');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const RAW_DIR = path.join(DATA_DIR, 'raw');
export const USAGE_HISTORY_PATH = path.join(DATA_DIR, 'usage-history.json');
export const USAGE_LATEST_PATH = path.join(DATA_DIR, 'usage-latest.json');
