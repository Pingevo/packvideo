/**
 * ตรวจรุ่นของ Node ก่อนรันสคริปต์อื่น
 *
 * ไฟล์นี้ต้องรันได้บน Node 12 ด้วย — ห้ามใช้ ?. ?? หรือไวยากรณ์ใหม่กว่านั้น
 * เพราะเป้าหมายคือให้มันทำงานได้ "บนรุ่นที่ผิด" เพื่ออธิบายว่าผิดตรงไหน
 *
 * เครื่องพัฒนามี Node 12 ของ sellcenter อยู่บน PATH การรัน npm run ...
 * โดยลืม nvm use จะได้ SyntaxError ที่ชี้ไปยังไฟล์ภายในของ Node
 * ซึ่งไม่มีอะไรบอกเลยว่าสาเหตุจริงคือรุ่นของ Node
 */

var REQUIRED = 22;
var current = parseInt(process.versions.node.split('.')[0], 10);

if (current < REQUIRED) {
  var msg = [
    '',
    '  [31m✗ ต้องใช้ Node ' + REQUIRED + ' ขึ้นไป แต่ตอนนี้เป็น Node ' + process.versions.node + '[0m',
    '',
    '  เครื่องนี้มี Node 12 ของ sellcenter อยู่บน PATH ด้วย',
    '  สั่งบรรทัดนี้ก่อนแล้วลองใหม่:',
    '',
    '      [36mnvm use[0m',
    '',
    '  ถ้ายังไม่มี Node ' + REQUIRED + ':  [36mnvm install ' + REQUIRED + '[0m',
    '  รายละเอียด: docs/dev-setup.md',
    '',
  ].join('\n');
  process.stderr.write(msg + '\n');
  process.exit(1);
}
