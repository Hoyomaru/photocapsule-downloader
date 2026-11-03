// 確認用ページを手元で表示するための小さなサーバー
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
http.createServer((req, res) => {
  if (req.url.startsWith('/photocapsule-downloader.user.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(root, 'photocapsule-downloader.user.js')));
  }
  const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + page + '</body></html>');
}).listen(5317);
