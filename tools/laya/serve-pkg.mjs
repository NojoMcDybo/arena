// wie ein GitHub-Release: Dateien unter ihrem Release-Namen, mit Range (206) fuer fortgesetzte Downloads
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
// node tools/laya/serve-pkg.mjs <ordner>/pkg
const root = path.resolve(process.argv[2] ?? "pkg");

http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end(); }
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (m) {
      const start = Number(m[1]);
console.log("Range", path.basename(f), "ab", start);
      res.writeHead(206, { "Content-Length": st.size - start, "Content-Range": `bytes ${start}-${st.size - 1}/${st.size}` });
      return fs.createReadStream(f, { start }).pipe(res);
    }
    res.writeHead(200, { "Content-Length": st.size });
    fs.createReadStream(f).pipe(res);
  });
}).listen(8767, () => console.log("serving pkg 8767"));
