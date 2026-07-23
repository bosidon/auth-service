const nodemailer = require('nodemailer');
const crypto = require('crypto');
const SMTP = {
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465'),
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM
};
console.log("SMTP_HOST:", SMTP.host);
console.log("SMTP_PORT:", SMTP.port);
console.log("SMTP_USER:", SMTP.user);
console.log("SMTP_PASS:", SMTP.pass ? "***SET***" : "NOT SET");

const transporter = nodemailer.createTransport({
  host: SMTP.host,
  port: SMTP.port,
  secure: true,
  auth: { user: SMTP.user, pass: SMTP.pass }
});

transporter.sendMail({
  from: SMTP.from,
  to: "10212643@qq.com",
  subject: "测试邮件 - 仙宝密码重置",
  text: "这是一封测试邮件，如果收到说明SMTP配置正确。"
}).then(info => {
  console.log("SENT:", info.messageId);
  process.exit(0);
}).catch(e => {
  console.log("FAIL:", e.message);
  process.exit(1);
});
