import { getBuffer, subscribe } from '$lib/server/log-buffer';
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

			send({ type: 'init', entries: getBuffer() });
			unsubscribe = subscribe((entry) => send({ type: 'entry', entry }));
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
