#!/usr/bin/env bash
# Generate T-03 attachments and mails/sizes.txt (bytes, sha256, estimated raw size).
source "$(dirname "$0")/../env.sh"
mkdir -p "$(dirname "$0")/mails" && cd "$(dirname "$0")/mails" || exit 1
node -e '
const c=require("crypto"),fs=require("fs");
function mk(f,n,pdf){
  const head=pdf?Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%"):Buffer.alloc(0);
  const tail=pdf?Buffer.from("\ntrailer<</Root 1 0 R>>\n%%EOF\n"):Buffer.alloc(0);
  const b=Buffer.concat([head,c.randomBytes(n-head.length-tail.length),tail]);
  fs.writeFileSync(f,b);return b}
let t="";
for(const [f,n,p] of [["t03-under-cap.pdf",15*1048576,true],["t03-over-cap.bin",20*1048576,false]]){
  const b=mk(f,n,p);const raw=Math.ceil(b.length/57)*78+3000;
  t+=f+" bytes="+b.length+" sha256="+c.createHash("sha256").update(b).digest("hex")+" est_raw_mib="+(raw/1048576).toFixed(1)+"\n"}
fs.writeFileSync("sizes.txt",t);console.log(t)'
