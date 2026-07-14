const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../database/auth.db');
const SCHEMA_PATH = path.join(__dirname, '../database/schema.sql');

let db;

function initDatabase() {
  const sqlite3 = require('sqlite3').verbose();

  // 确保目录存在
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('数据库连接失败:', err.message);
      return;
    }
    console.log('✅ 数据库连接成功');

    // 执行schema
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema, (err) => {
      if (err) {
        console.error('Schema执行失败:', err.message);
      } else {
        console.log('✅ 数据库表创建完成');
      }
    });
  });

  return db;
}

function getDb() {
  return db;
}

// 封装Promise查询
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

module.exports = { initDatabase, getDb, query, get, run };
