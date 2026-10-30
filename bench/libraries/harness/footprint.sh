set -e
cd ~ && rm -rf fp && mkdir fp && cd fp
echo "[" > ~/conf/results_footprint.json
first=1
for spec in rusteerio@1.1.6 cheerio@1.2.0 jsdom@30.1.3 htmlparser2@12.0.0 parse5@8.0.1 node-html-parser@9.0.4; do
  name=${spec%@*}
  mkdir $name && cd $name && npm init -y >/dev/null && npm i --omit=dev --no-audit --no-fund $spec >/dev/null 2>&1
  bytes=$(du -sb node_modules | cut -f1)
  pkgs=$(find node_modules -name package.json -not -path "*/node_modules/*/node_modules/*/test/*" | xargs -I{} dirname {} | grep -cE "node_modules/(@[^/]+/)?[^/]+$")
  times=$(for i in $(seq 1 15); do node -e "const t=process.hrtime.bigint(); require('$name'); console.log(Number(process.hrtime.bigint()-t)/1e6)"; done | sort -n | tr "\n" " ")
  [ $first = 1 ] || echo "," >> ~/conf/results_footprint.json; first=0
  echo "{\"lib\":\"$name\",\"spec\":\"$spec\",\"installBytes\":$bytes,\"packages\":$pkgs,\"requireMs\":[${times// /,}0]}" | sed 's/,0]}/]}/' >> ~/conf/results_footprint.json
  cd ..
done
echo "]" >> ~/conf/results_footprint.json
cat ~/conf/results_footprint.json
