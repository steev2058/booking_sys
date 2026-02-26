const driver = String(process.env.STORAGE_DRIVER || 'json').toLowerCase();

if (driver === 'mysql') {
  module.exports = require('./store_mysql');
} else {
  module.exports = require('./store_json');
}
