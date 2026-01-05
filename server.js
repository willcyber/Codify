const http = require('http');
const url = require('url');

let currentHTML = '<!DOCTYPE html><html><head><title>Codify - No website generated yet</title></head><body><h1>Waiting for website...</h1></body></html>';
let pages = {}; // Store multiple pages: { "index.html": "<html>...", "cool.html": "<html>..." }
const PORT = 8765;

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  
  if (req.method === 'POST' && parsedUrl.pathname === '/update') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        
        // Handle multi-page format
        if (data.pages && Array.isArray(data.pages)) {
          pages = {};
          data.pages.forEach(page => {
            if (page.name && page.html) {
              pages[page.name] = page.html;
              console.log(`[Server] Registered page: ${page.name}`);
            }
          });
          // Set default page (index.html or first page)
          currentHTML = pages['index.html'] || pages[Object.keys(pages)[0]] || currentHTML;
          console.log(`[Server] Multi-page site updated. Total pages: ${Object.keys(pages).length}`);
          console.log(`[Server] Available pages: ${Object.keys(pages).join(', ')}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, pages: Object.keys(pages) }));
        }
        // Handle single-page format (backward compatible)
        else if (data.html) {
          currentHTML = data.html;
          pages = { 'index.html': data.html };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No HTML or pages provided' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else if (req.method === 'GET') {
    // Serve specific page or default
    const pathname = parsedUrl.pathname;
    let htmlToServe = currentHTML;
    
    if (pathname === '/' || pathname === '/index.html') {
      htmlToServe = pages['index.html'] || currentHTML;
      console.log(`[Server] Serving: / (index.html)`);
    } else if (pathname.startsWith('/')) {
      const pageName = pathname.substring(1); // Remove leading /
      htmlToServe = pages[pageName] || currentHTML;
      if (pages[pageName]) {
        console.log(`[Server] Serving: ${pathname} (${pageName})`);
      } else {
        console.log(`[Server] Page not found: ${pathname}, serving default`);
      }
    }
    
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlToServe);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, 'localhost', () => {
  console.log(`Codify server running at http://localhost:${PORT}`);
  console.log('Keep this server running while using the extension.');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use. The server may already be running.`);
  } else {
    console.error('Server error:', err);
  }
});

