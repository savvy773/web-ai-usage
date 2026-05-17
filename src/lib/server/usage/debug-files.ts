import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RAW_DIR } from '$lib/server/file-paths';
import type { ProviderId, ProviderUsage } from '$lib/usage';

const MAX_RAW_CHARS = 40_000;

type CollectorDebugSnapshotOptions = {
	attempt?: number;
	maxAttempts?: number;
	phase?: string;
	markers?: string[];
	parseDiagnostics?: string[];
	writeFailureCopy?: boolean;
};

export async function writeCollectorDebugSnapshot(
	providerId: ProviderId,
	rawOutput: string,
	result: ProviderUsage,
	options: CollectorDebugSnapshotOptions = {}
) {
	await mkdir(RAW_DIR, { recursive: true });

	const rawTail = rawOutput.slice(-MAX_RAW_CHARS);
	const snapshot = {
		writtenAt: new Date().toISOString(),
		provider: result.provider,
		status: result.status,
		message: result.message,
		collectedAt: result.collectedAt,
		collectionDurationMs: result.collectionDurationMs,
		rawOutputChars: rawOutput.length,
		rawTailChars: rawTail.length,
		attempt: options.attempt ?? null,
		maxAttempts: options.maxAttempts ?? null,
		phase: options.phase ?? null,
		markers: options.markers ?? [],
		parseDiagnostics: options.parseDiagnostics ?? [],
		windows: result.windows,
		modelUsages: result.modelUsages,
		rawPreview: result.rawPreview
	};

	const writes = [
		writeFile(path.join(RAW_DIR, `${providerId}-latest.txt`), rawTail, 'utf8'),
		writeFile(
			path.join(RAW_DIR, `${providerId}-latest.parsed.json`),
			`${JSON.stringify(snapshot, null, 2)}\n`,
			'utf8'
		)
	];

	if (options.writeFailureCopy) {
		writes.push(
			writeFile(path.join(RAW_DIR, `${providerId}-last-failure.txt`), rawTail, 'utf8'),
			writeFile(
				path.join(RAW_DIR, `${providerId}-last-failure.parsed.json`),
				`${JSON.stringify(snapshot, null, 2)}\n`,
				'utf8'
			)
		);
	}

	await Promise.all(writes);
}
