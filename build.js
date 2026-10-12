const fs = require('fs');
const path = require('path');

const root = __dirname;
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const license = fs.readFileSync(path.join(root, 'assets/LICENSE-GL-MahjongTile.txt'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8').replace("url('assets/GL-MahjongTile.ttf')", `url('data:font/ttf;base64,${fs.readFileSync(path.join(root, 'assets/GL-MahjongTile.ttf')).toString('base64')}')`);

html = html.replace('<link rel="stylesheet" href="style.css" />', `<!-- ${license} -->\n<style>\n${css}\n</style>`);
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  const js = fs.readFileSync(path.join(root, src), 'utf8');
  return `<script>\n${js}\n</script>`;
});

fs.writeFileSync(path.join(root, 'mahjong.html'), html);
console.log('built mahjong.html', html.length, 'bytes');
