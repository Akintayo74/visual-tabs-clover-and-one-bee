import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local stand-ins for real sites, so the e2e suite runs offline and the same way every time.
 * Each variant exercises a different layout the fingerprint has to describe.
 */
const FONTS = ['Georgia, serif', 'Helvetica, Arial, sans-serif', '"Courier New", monospace'];
const COLOURS: [string, string][] = [
  ['#0b0b0f', '#f5f5f0'],
  ['#ffffff', '#111111'],
  ['#ff5a1f', '#1a1a1a'],
  ['#e8f0ff', '#0a2a66'],
  ['#1d3b2a', '#f0e9d8'],
];

function page(title: string, body: string, head = '', style = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">${head}
<style>body{margin:0}${style}</style></head><body>${body}</body></html>`;
}

function variant(n: number): string {
  const [bg, fg] = COLOURS[n % COLOURS.length] ?? ['#fff', '#000'];
  const font = FONTS[n % FONTS.length] ?? 'sans-serif';
  const base = `body{background:${bg};color:${fg};font-family:${font}}`;
  const sections = (count: number, height: string) =>
    Array.from(
      { length: count },
      (_, i) =>
        `<section style="min-height:${height};padding:48px"><h2 style="font-size:40px">Section ${String(i + 1)}</h2><p>${'Body copy for the section. '.repeat(12)}</p></section>`,
    ).join('');
  switch (n % 6) {
    case 0:
      return page(
        `Studio ${String(n)} — Landing`,
        `<header style="display:flex;justify-content:space-between;padding:24px"><strong>Studio ${String(n)}</strong><nav><a href="/about">About</a> <a href="/work">Work</a> <a href="https://twitter.com/x">Twitter</a></nav></header>
<main><section style="height:90vh;display:grid;place-items:center"><h1 style="font-size:96px;margin:0">We make calm software</h1></section>${sections(4, '70vh')}</main>
<footer style="padding:48px">© Studio</footer>`,
        `<link rel="canonical" href="/site/${String(n)}"><meta property="og:site_name" content="Studio ${String(n)}">`,
        base,
      );
    case 1:
      return page(
        `Index ${String(n)}`,
        `<main style="height:100vh;display:flex;flex-direction:column;justify-content:center;padding:4vw">
<a href="/projects" style="font-size:120px;color:inherit;text-decoration:none">Projects</a>
<a href="/journal" style="font-size:120px;color:inherit;text-decoration:none">Journal</a>
<a href="/contact" style="font-size:120px;color:inherit;text-decoration:none">Contact</a></main>`,
        '',
        base,
      );
    case 2:
      return page(
        `Portfolio grid ${String(n)}`,
        `<header style="padding:24px"><h1 style="font-size:28px">Portfolio</h1></header><main style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:24px">${Array.from(
          { length: 18 },
          (_, i) =>
            `<a href="/p/${String(i)}" style="display:block;aspect-ratio:4/3;background:hsl(${String(i * 20)} 60% 60%)"></a>`,
        ).join('')}</main><footer>Footer</footer>`,
        '',
        base,
      );
    case 3:
      return page(
        `A long essay ${String(n)}`,
        `<article style="max-width:680px;margin:0 auto;padding:64px 24px"><h1 style="font-size:52px">On the shape of memory</h1>${'<p style="font-size:19px;line-height:1.6">'.concat('Paragraph of an essay about how designers remember websites by their shape. '.repeat(20), '</p>').repeat(25)}</article>`,
        '',
        base,
      );
    case 4:
      return page(
        `Canvas ${String(n)}`,
        `<canvas id="c" style="position:fixed;inset:0;width:100vw;height:100vh"></canvas><h1 style="position:relative;font-size:72px;padding:40px">Immersive</h1>
<script>const c=document.getElementById('c');c.width=innerWidth;c.height=innerHeight;const g=c.getContext('2d');const grd=g.createLinearGradient(0,0,c.width,c.height);grd.addColorStop(0,'#6a00ff');grd.addColorStop(1,'#00e0ff');g.fillStyle=grd;g.fillRect(0,0,c.width,c.height);window.THREE={REVISION:'160'};</script>`,
        '',
        base,
      );
    default:
      return page(
        `Minimal ${String(n)}`,
        `<main style="height:100vh;display:grid;place-items:center"><p style="font-size:14px;letter-spacing:.2em">COMING SOON</p></main>`,
        '',
        base,
      );
  }
}

/** A page with 20k elements, to check the fingerprint stays bounded. */
function huge(): string {
  return page('Huge', `<main>${'<div><span>cell</span></div>'.repeat(10000)}</main>`);
}

/** Blocks the main thread for a while, to check saves don't wait forever on the page. */
function busy(): string {
  return page(
    'Busy',
    `<h1>Busy page</h1><script>addEventListener('load',()=>setTimeout(()=>{const end=Date.now()+4000;while(Date.now()<end){}},50));</script>`,
  );
}

export interface SiteServer {
  origin: string;
  url(path: string): string;
  close(): Promise<void>;
}

export async function startSites(): Promise<SiteServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let html: string | null = null;
    const match = /^\/site\/(\d+)$/.exec(url.pathname);
    if (match?.[1]) html = variant(Number(match[1]));
    else if (url.pathname === '/huge') html = huge();
    else if (url.pathname === '/busy') html = busy();
    if (html === null) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;
  return {
    origin,
    url: (path) => origin + path,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
