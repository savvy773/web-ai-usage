import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	setTimeout(() => process.exit(0), 200);
	return new Response(JSON.stringify({ ok: true }), {
		headers: { 'Content-Type': 'application/json' }
	});
};
