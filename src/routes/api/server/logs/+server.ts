import { clearBuffer, getInitialBuffer, subscribe } from '$lib/server/log-buffer';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	let unsubscribe: (() => void) | null = null;
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			const send = (data: object) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					unsubscribe?.();
				}
			};

			getInitialBuffer()
				.then((entries) => {
					send({ type: 'init', entries });
					unsubscribe = subscribe((entry) => send({ type: 'entry', entry }));
				})
				.catch(() => {
					send({ type: 'init', entries: [] });
					unsubscribe = subscribe((entry) => send({ type: 'entry', entry }));
				});
		},
		cancel() {
			unsubscribe?.();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};

export const DELETE: RequestHandler = () => {
	clearBuffer();
	return new Response(null, { status: 204 });
};
