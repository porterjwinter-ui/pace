// Optional: a tiny proxy so Pace can load calendar links (.ics) whose servers block browsers.
// Deploy free on Cloudflare Workers (dash.cloudflare.com → Workers → Create → paste this file).
// Then in Pace: Settings → Account and sync → Proxy for calendar links:
//   https://<your-worker>.workers.dev/?url={url}
//
// Set ALLOWED_ORIGIN to the site Pace runs on so nobody else can use your proxy.
const ALLOWED_ORIGIN = 'https://porterjwinter-ui.github.io';

export default {
  async fetch(request) {
    const cors = { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'GET', Vary: 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const origin = request.headers.get('Origin');
    if (origin && origin !== ALLOWED_ORIGIN) return new Response('Forbidden', { status: 403 });

    const target = new URL(request.url).searchParams.get('url') || '';
    if (!/^(https?|webcal):\/\//i.test(target)) return new Response('Missing or invalid url', { status: 400, headers: cors });

    const upstream = await fetch(target.replace(/^webcal:/i, 'https:'), { headers: { 'User-Agent': 'Pace calendar proxy' } });
    const body = await upstream.text();
    if (!/BEGIN:VCALENDAR/i.test(body.slice(0, 4000))) return new Response('That link did not return a calendar', { status: 422, headers: cors });

    return new Response(body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300' },
    });
  },
};
