module.exports = {
  apps: [{
    name: "xianbao-auth",
    script: "./server.js",
    cwd: "/var/www/auth.xianbao.online",
    env: {
      SMTP_HOST: "smtp.qq.com",
      SMTP_PORT: "465",
      SMTP_USER: "10212643@qq.com",
      SMTP_PASS: "uhcparwfxtkpbhcg",
      SMTP_FROM: "仙宝心灵成长 <10212643@qq.com>"
    }
  }]
}
