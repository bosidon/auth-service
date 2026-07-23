const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
transporter.verify().then(() => {
  console.log("SMTP_OK");
  process.exit(0);
}).catch(e => {
  console.log("SMTP_FAIL:", e.message);
  process.exit(1);
});
